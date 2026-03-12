import * as lancedb from '@lancedb/lancedb';
import { clearDbCacheForPath, getTableSchemaFields, openMemoryTable, openMemoryTableByName, sanitizeRecordsForSchema } from '../db/table';
import { existsSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { PluginDebugLogger } from '../debug/logger';
import { embedText } from './embedder';
import { discoverMemoryTables, resolveLanceDbPath } from './table-discovery';
import { backfillLifecycleFields } from '../memory/lifecycle';
import type { PluginConfig } from '../types';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 20;
const ACTIVE_RETRY_INTERVAL_MS = 1_000;
const EMBEDDING_MIN_INTERVAL_MS = 250;
const EMBEDDING_429_MAX_RETRIES = 3;
const EMBEDDING_429_BASE_BACKOFF_MS = 1_000;
const EMBEDDING_RATE_LIMIT_COOLDOWN_MS = 30_000;
const VOYAGE_MAX_BATCH_SIZE = 5;
const REQUIRED_SCHEMA_FIELDS = [
  'session_id',
  'agent_id',
  'memory_type',
  'strength',
  'stability',
  'last_access_ts',
  'next_review_ts',
  'access_count',
  'inhibition_weight',
  'inhibition_until',
  'utility_score',
  'risk_score',
  'retention_deadline',
  'lifecycle_state',
];

type MigrationBatchResult = {
  migrated: number;
  failed: number;
  legacyTables: number;
  retryableFailures: number;
};

type MigrationStatusSnapshot = {
  phase: 'running' | 'retry_backoff' | 'done' | 'idle';
  ts: string;
  currentDimension: number;
  batchSize: number;
  migrated: number;
  failed: number;
  legacyTables: number;
  retryableFailures: number;
  currentTableRows: number;
  legacyRowCount: number;
  lastError?: string;
  retryCount?: number;
  delayMs?: number;
};

export class EmbeddingMigrationWorker {
  private readonly config: PluginConfig;
  private readonly debug?: PluginDebugLogger;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private loopEnabled = false;
  private lastEmbeddingAttemptAt = 0;

  constructor(config: PluginConfig, debug?: PluginDebugLogger) {
    this.config = config;
    this.debug = debug;
  }

  start(intervalMs: number = this.getMigrationConfig().intervalMs): void {
    if (this.loopEnabled || !this.getMigrationConfig().enabled) {
      return;
    }

    this.loopEnabled = true;
    void this.runLoop(intervalMs).catch((error) => {
      this.handleLoopError(error);
    });
  }

  stop(): void {
    this.loopEnabled = false;
    if (!this.timer) {
      return;
    }

    clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.running || !this.getMigrationConfig().enabled) {
      return;
    }

    this.running = true;
    try {
      await this.migrateBatch();
    } finally {
      this.running = false;
    }
  }

  protected async upsertCurrentRow(row: Record<string, unknown>): Promise<void> {
    const currentDim = this.config.embedding?.dimension || 16;
    const targetTable = await openMemoryTable(this.config.lancedbPath, currentDim);
    const allowedFields = await getTableSchemaFields(targetTable);
    const safeRows = sanitizeRecordsForSchema([row], allowedFields);

    await targetTable.mergeInsert('memory_uid')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(safeRows);
  }

  protected async requestEmbedding(text: string): Promise<number[]> {
    return embedText(text, this.config.embedding);
  }

  protected async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async runLoop(idleIntervalMs: number): Promise<void> {
    if (!this.loopEnabled) {
      return;
    }

    const result = await this.runOnceWithResult();
    if (!this.loopEnabled) {
      return;
    }

    const hasPendingLegacy = result.legacyTables > 0;
    const shouldContinueSoon = hasPendingLegacy && (result.migrated > 0 || result.retryableFailures > 0);
    const nextDelay = result.retryableFailures > 0
      ? EMBEDDING_RATE_LIMIT_COOLDOWN_MS
      : shouldContinueSoon
        ? ACTIVE_RETRY_INTERVAL_MS
        : idleIntervalMs;
    this.scheduleNextRun(nextDelay, idleIntervalMs);
  }

  private scheduleNextRun(delayMs: number, idleIntervalMs: number): void {
    if (!this.loopEnabled) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.runLoop(idleIntervalMs).catch((error) => {
        this.handleLoopError(error);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private handleLoopError(error: unknown): void {
    this.debug?.error('embedding_migration.loop_error', {
      message: error instanceof Error ? error.message : String(error),
    });
    console.error('[EmbeddingMigrationWorker] Migration loop failed:', error);
  }

  private async runOnceWithResult(): Promise<MigrationBatchResult> {
    if (this.running || !this.getMigrationConfig().enabled) {
      return { migrated: 0, failed: 0, legacyTables: 0, retryableFailures: 0 };
    }

    this.running = true;
    try {
      return await this.migrateBatch();
    } finally {
      this.running = false;
    }
  }

  private async migrateBatch(): Promise<MigrationBatchResult> {
    const currentDim = this.config.embedding?.dimension || 16;
    const existingTableNames = await this.listKnownTableNames();
    await this.backupOrphanLegacyTables(existingTableNames);
    const renamedActiveTable = await this.renameOutdatedActiveTable(currentDim);
    if (renamedActiveTable) {
      clearDbCacheForPath(this.config.lancedbPath);
    }

    const batchSize = this.getEffectiveBatchSize();
    const tables = await discoverMemoryTables(this.config.lancedbPath, currentDim);
    const legacyTables = tables.filter((table) => table.name.includes('_legacy_') || table.dimension !== currentDim);
    let migrated = 0;
    let failed = 0;
    let retryableFailures = 0;

    if (legacyTables.length === 0) {
      await this.writeMigrationStatus({
        phase: 'idle',
        currentDimension: currentDim,
        batchSize,
        migrated,
        failed,
        legacyTables: 0,
        retryableFailures,
      });
      this.debug?.basic('embedding_migration.skipped', { reason: 'no_legacy_tables' });
      return { migrated, failed, legacyTables: 0, retryableFailures };
    }

    await this.writeMigrationStatus({
      phase: 'running',
      currentDimension: currentDim,
      batchSize,
      migrated,
      failed,
      legacyTables: legacyTables.length,
      retryableFailures,
    });
    this.debug?.basic('embedding_migration.start', { sourceTables: legacyTables.length, targetDimension: currentDim, batchSize });

    let remaining = batchSize;
    for (const tableInfo of legacyTables) {
      if (remaining <= 0) {
        break;
      }

      const sourceTable = await openMemoryTableByName(this.config.lancedbPath, tableInfo.name);
      const rows = await sourceTable
        .query()
        .where("status != 'deleted'")
        .limit(remaining)
        .toArray();

      for (const row of rows) {
        if (remaining <= 0) {
          break;
        }

        if (!this.shouldMigrateRow(row)) {
          continue;
        }

        try {
          const migratedRow = this.toMigratedRow(
            row,
            await this.resolveMigratedVector(row, tableInfo.dimension, currentDim),
          );

          await this.upsertCurrentRow(migratedRow);
          await sourceTable.delete(`memory_uid = '${escapeSqlString(String(row.memory_uid || ''))}'`);
          remaining -= 1;
          migrated += 1;
          this.debug?.verbose('embedding_migration.row', { memoryUid: String(row.memory_uid || ''), sourceDimension: tableInfo.dimension, targetDimension: currentDim });
        } catch (err) {
          failed += 1;
          const isRateLimit = isRetryableRateLimitError(err);
          if (isRateLimit) {
            retryableFailures += 1;
          }
          this.debug?.error('embedding_migration.error', {
            memoryUid: String(row.memory_uid || ''),
            sourceDimension: tableInfo.dimension,
            targetDimension: currentDim,
            message: err instanceof Error ? err.message : String(err),
          });
          console.error(
            `[EmbeddingMigrationWorker] Failed to migrate memory_uid=${String(row.memory_uid || '')} `
            + `from d${tableInfo.dimension} to d${currentDim}:`,
            err,
          );

          if (isRateLimit) {
            await this.writeMigrationStatus({
              phase: 'retry_backoff',
              currentDimension: currentDim,
              batchSize,
              migrated,
              failed,
              legacyTables: legacyTables.length,
              retryableFailures,
              lastError: err instanceof Error ? err.message : String(err),
            });
            remaining = 0;
            break;
          }
        }
      }

      await this.backupLegacyTableIfEmpty(tableInfo.name, sourceTable);
    }

    await this.writeMigrationStatus({
      phase: legacyTables.length > 0 ? 'done' : 'idle',
      currentDimension: currentDim,
      batchSize,
      migrated,
      failed,
      legacyTables: legacyTables.length,
      retryableFailures,
    });
    this.debug?.basic('embedding_migration.done', { migrated, failed, targetDimension: currentDim });
    return { migrated, failed, legacyTables: legacyTables.length, retryableFailures };
  }

  private async embedLegacyText(text: string): Promise<number[]> {
    let retryCount = 0;

    while (true) {
      await this.waitForEmbeddingSlot();
      try {
        return await this.requestEmbedding(text);
      } catch (error) {
        if (!isRetryableRateLimitError(error) || retryCount >= EMBEDDING_429_MAX_RETRIES) {
          throw error;
        }

        const delayMs = EMBEDDING_429_BASE_BACKOFF_MS * (2 ** retryCount);
        retryCount += 1;
        this.debug?.warn('embedding_migration.retry_backoff', {
          retryCount,
          delayMs,
          message: error instanceof Error ? error.message : String(error),
        });
        await this.writeMigrationStatus({
          phase: 'retry_backoff',
          currentDimension: this.config.embedding?.dimension || 16,
          batchSize: this.getEffectiveBatchSize(),
          migrated: 0,
          failed: 0,
          legacyTables: 0,
          retryableFailures: 1,
          lastError: error instanceof Error ? error.message : String(error),
          retryCount,
          delayMs,
        });
        await this.sleep(delayMs);
      }
    }
  }

  private async resolveMigratedVector(row: any, sourceDim: number, targetDim: number): Promise<number[]> {
    const existingVector = toNumericVector(row?.vector);
    if (sourceDim === targetDim && existingVector.length === targetDim) {
      return [...existingVector];
    }
    return this.embedLegacyText(String(row?.text || ''));
  }

  private async waitForEmbeddingSlot(): Promise<void> {
    const waitMs = EMBEDDING_MIN_INTERVAL_MS - (Date.now() - this.lastEmbeddingAttemptAt);
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
    this.lastEmbeddingAttemptAt = Date.now();
  }

  private async backupLegacyTableIfEmpty(tableName: string, sourceTable: Awaited<ReturnType<typeof openMemoryTable>>): Promise<void> {
    const rowCount = await sourceTable.countRows();
    if (rowCount > 0) {
      return;
    }

    sourceTable.close();

    const dbPath = resolveLanceDbPath(this.config.lancedbPath);
    const lancePath = path.join(dbPath, `${tableName}.lance`);
    const backupPath = path.join(dbPath, `${tableName}.bak`);

    if (!existsSync(lancePath)) {
      return;
    }

    if (existsSync(backupPath)) {
      rmSync(backupPath, { recursive: true, force: true });
    }

    renameSync(lancePath, backupPath);
    this.debug?.basic('embedding_migration.backup_table', { tableName, backupPath });
  }

  private async backupOrphanLegacyTables(knownTableNames: string[]): Promise<void> {
    const dbPath = resolveLanceDbPath(this.config.lancedbPath);
    const known = new Set(knownTableNames);
    const entries = readdirSync(dbPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (!/^memory_records(?:_d\d+)?_legacy_\d+\.lance$/.test(entry.name)) {
        continue;
      }

      const tableName = entry.name.replace(/\.lance$/, '');
      if (known.has(tableName)) {
        continue;
      }

      const orphanPath = path.join(dbPath, entry.name);
      const backupPath = path.join(dbPath, `${tableName}.bak`);
      if (existsSync(backupPath)) {
        rmSync(backupPath, { recursive: true, force: true });
      }
      renameSync(orphanPath, backupPath);
      this.debug?.basic('embedding_migration.backup_orphan_legacy', { tableName, backupPath });
    }
  }

  private async listKnownTableNames(): Promise<string[]> {
    const dbPath = resolveLanceDbPath(this.config.lancedbPath);
    try {
      const db = await lancedb.connect(dbPath);
      return db.tableNames();
    } catch (error) {
      this.debug?.warn('embedding_migration.table_names_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private async renameOutdatedActiveTable(currentDim: number): Promise<boolean> {
    const dbPath = resolveLanceDbPath(this.config.lancedbPath);
    const tableName = currentDim === 16 ? 'memory_records' : `memory_records_d${currentDim}`;
    const db = await lancedb.connect(dbPath);
    const tableNames = await db.tableNames();

    if (!tableNames.includes(tableName)) {
      return false;
    }

    const activeTable = await db.openTable(tableName);
    const activeFields = await getTableSchemaFields(activeTable);
    if (REQUIRED_SCHEMA_FIELDS.every((field) => activeFields.has(field))) {
      return false;
    }

    activeTable.close();

    const lancePath = path.join(dbPath, `${tableName}.lance`);
    if (!existsSync(lancePath)) {
      return false;
    }

    const legacyPath = path.join(dbPath, `${tableName}_legacy_${Date.now()}.lance`);
    renameSync(lancePath, legacyPath);
    this.debug?.basic('embedding_migration.schema_upgrade', { tableName, legacyPath });
    return true;
  }

  private shouldMigrateRow(row: any): boolean {
    if (!row?.memory_uid) {
      return false;
    }

    if (row?.status === 'deleted') {
      return false;
    }

    const text = String(row?.text || '').trim();
    if (!text) {
      return false;
    }

    return true;
  }

  private toMigratedRow(row: any, vector: number[]): Record<string, unknown> {
    const input: any = {
      memory_uid: String(row.memory_uid || ''),
      user_id: String(row.user_id || ''),
      run_id: String(row.run_id || ''),
      scope: (row.scope === 'session' ? 'session' : 'long-term'),
      text: String(row.text || ''),
      categories: Array.isArray(row.categories) ? [...row.categories] : [],
      tags: Array.isArray(row.tags) ? [...row.tags] : [],
      memory_type: String(row.memory_type || 'generic'),
      domains: Array.isArray(row.domains) ? [...row.domains] : ['generic'],
      source_kind: String(row.source_kind || 'user_explicit'),
      confidence: Number(row.confidence || 0.7),
      ts_event: String(row.ts_event || new Date().toISOString()),
      source: 'openclaw',
      status: row.status === 'deleted' ? 'deleted' : row.status === 'superseded' ? 'superseded' : 'active',
      sensitivity: row.sensitivity === 'public' || row.sensitivity === 'confidential' || row.sensitivity === 'restricted'
        ? row.sensitivity
        : 'internal',
      lifecycle_state: String(row.lifecycle_state || ''),
      strength: typeof row.strength === 'number' ? row.strength : undefined,
      stability: typeof row.stability === 'number' ? row.stability : undefined,
      last_access_ts: String(row.last_access_ts || ''),
      next_review_ts: String(row.next_review_ts || ''),
      access_count: typeof row.access_count === 'number' ? row.access_count : undefined,
      inhibition_weight: typeof row.inhibition_weight === 'number' ? row.inhibition_weight : undefined,
      inhibition_until: String(row.inhibition_until || ''),
      utility_score: typeof row.utility_score === 'number' ? row.utility_score : undefined,
      risk_score: typeof row.risk_score === 'number' ? row.risk_score : undefined,
      retention_deadline: String(row.retention_deadline || ''),
      openclaw_refs: String(row.openclaw_refs || '{}'),
      mem0: {
        mem0_id: String(row.mem0_id || ''),
        event_id: String(row.mem0_event_id || ''),
        hash: String(row.mem0_hash || ''),
      },
    };
    const enriched: any = backfillLifecycleFields(input as any);

    return {
      memory_uid: enriched.memory_uid,
      user_id: enriched.user_id,
      session_id: enriched.session_id || '',
      agent_id: enriched.agent_id || '',
      run_id: enriched.run_id || '',
      scope: enriched.scope,
      text: enriched.text,
      categories: Array.isArray(enriched.categories) ? [...enriched.categories] : [],
      tags: Array.isArray(enriched.tags) ? [...enriched.tags] : [],
      memory_type: enriched.memory_type || 'generic',
      domains: Array.isArray(enriched.domains) ? [...enriched.domains] : ['generic'],
      source_kind: enriched.source_kind || 'user_explicit',
      confidence: Number(enriched.confidence || 0.7),
      ts_event: enriched.ts_event,
      source: enriched.source,
      status: enriched.status,
      sensitivity: enriched.sensitivity || 'internal',
      strength: enriched.strength,
      stability: enriched.stability,
      last_access_ts: enriched.last_access_ts,
      next_review_ts: enriched.next_review_ts,
      access_count: enriched.access_count,
      inhibition_weight: enriched.inhibition_weight,
      inhibition_until: enriched.inhibition_until,
      utility_score: enriched.utility_score,
      risk_score: enriched.risk_score,
      retention_deadline: enriched.retention_deadline,
      lifecycle_state: enriched.lifecycle_state,
      openclaw_refs: typeof enriched.openclaw_refs === 'string' ? enriched.openclaw_refs : JSON.stringify(enriched.openclaw_refs || {}),
      mem0_id: String(enriched.mem0?.mem0_id || ''),
      mem0_event_id: String(enriched.mem0?.event_id || ''),
      mem0_hash: String(enriched.mem0?.hash || ''),
      lancedb_row_key: String(row.lancedb_row_key || row.memory_uid || ''),
      vector,
    };
  }

  private getMigrationConfig() {
    return {
      enabled: this.config.embeddingMigration?.enabled ?? true,
      intervalMs: this.config.embeddingMigration?.intervalMs || DEFAULT_INTERVAL_MS,
      batchSize: this.config.embeddingMigration?.batchSize || DEFAULT_BATCH_SIZE,
    };
  }

  private getEffectiveBatchSize(): number {
    const configured = this.getMigrationConfig().batchSize;
    if (this.config.embedding?.provider === 'voyage') {
      return Math.min(configured, VOYAGE_MAX_BATCH_SIZE);
    }
    return configured;
  }

  private async writeMigrationStatus(partial: Omit<MigrationStatusSnapshot, 'ts' | 'currentTableRows' | 'legacyRowCount'>): Promise<void> {
    const dbPath = resolveLanceDbPath(this.config.lancedbPath);
    const snapshot: MigrationStatusSnapshot = {
      ...partial,
      ts: new Date().toISOString(),
      currentTableRows: await this.countTableRows(partial.currentDimension),
      legacyRowCount: await this.countLegacyRows(partial.currentDimension),
    };
    writeFileSync(path.join(dbPath, 'embedding_migration_status.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  private async countTableRows(dimension: number): Promise<number> {
    try {
      const table = await openMemoryTable(this.config.lancedbPath, dimension);
      return await table.countRows();
    } catch {
      return 0;
    }
  }

  private async countLegacyRows(currentDimension: number): Promise<number> {
    try {
      const tables = await discoverMemoryTables(this.config.lancedbPath, currentDimension);
      let total = 0;
      for (const tableInfo of tables) {
        if (tableInfo.dimension === currentDimension) {
          continue;
        }
        const table = await openMemoryTableByName(this.config.lancedbPath, tableInfo.name);
        total += await table.countRows();
      }
      return total;
    } catch {
      return 0;
    }
  }
}

function toNumericVector(rawVector: unknown): number[] {
  if (Array.isArray(rawVector)) {
    return rawVector.filter((value: unknown) => typeof value === 'number');
  }

  if (ArrayBuffer.isView(rawVector)) {
    return Array.from(rawVector as unknown as Iterable<number>).filter((value: unknown) => typeof value === 'number');
  }

  if (rawVector && typeof rawVector === 'object') {
    const candidate = rawVector as { length?: unknown; [Symbol.iterator]?: () => Iterator<unknown> };
    if (typeof candidate[Symbol.iterator] === 'function') {
      return Array.from(candidate as unknown as Iterable<unknown>).filter((value: unknown): value is number => typeof value === 'number');
    }
    if (typeof candidate.length === 'number') {
      const values: number[] = [];
      for (let index = 0; index < candidate.length; index += 1) {
        const value = (rawVector as Record<number, unknown>)[index];
        if (typeof value === 'number') {
          values.push(value);
        }
      }
      return values;
    }
  }

  return [];
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function isRetryableRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b/.test(message) || /rate.?limit/i.test(message);
}
