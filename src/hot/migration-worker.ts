import { openMemoryTable } from '../db/table';
import * as lancedb from '@lancedb/lancedb';
import type { PluginDebugLogger } from '../debug/logger';
import { embedText } from './embedder';
import { discoverMemoryTables, resolveLanceDbPath } from './table-discovery';
import type { PluginConfig } from '../types';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 20;

export class EmbeddingMigrationWorker {
  private readonly config: PluginConfig;
  private readonly debug?: PluginDebugLogger;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(config: PluginConfig, debug?: PluginDebugLogger) {
    this.config = config;
    this.debug = debug;
  }

  start(intervalMs: number = this.getMigrationConfig().intervalMs): void {
    if (this.timer || !this.getMigrationConfig().enabled) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runOnce();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
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

    await targetTable.mergeInsert('memory_uid')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute([row]);
  }

  private async migrateBatch(): Promise<void> {
    const currentDim = this.config.embedding?.dimension || 16;
    const batchSize = this.getMigrationConfig().batchSize;
    const tables = await discoverMemoryTables(this.config.lancedbPath, currentDim);
    const legacyTables = tables.filter((table) => table.dimension !== currentDim);
    let migrated = 0;
    let failed = 0;

    if (legacyTables.length === 0) {
      this.debug?.basic('embedding_migration.skipped', { reason: 'no_legacy_tables' });
      return;
    }

    this.debug?.basic('embedding_migration.start', { sourceTables: legacyTables.length, targetDimension: currentDim, batchSize });

    let remaining = batchSize;
    for (const tableInfo of legacyTables) {
      if (remaining <= 0) {
        break;
      }

      const sourceTable = await openMemoryTable(this.config.lancedbPath, tableInfo.dimension);
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
            await embedText(String(row.text || ''), this.config.embedding),
          );

          await this.upsertCurrentRow(migratedRow);
          await sourceTable.delete(`memory_uid = '${escapeSqlString(String(row.memory_uid || ''))}'`);
          remaining -= 1;
          migrated += 1;
          this.debug?.verbose('embedding_migration.row', { memoryUid: String(row.memory_uid || ''), sourceDimension: tableInfo.dimension, targetDimension: currentDim });
        } catch (err) {
          failed += 1;
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
        }
      }

      await this.dropLegacyTableIfEmpty(tableInfo.name, sourceTable);
    }

    this.debug?.basic('embedding_migration.done', { migrated, failed, targetDimension: currentDim });
  }

  private async dropLegacyTableIfEmpty(tableName: string, sourceTable: Awaited<ReturnType<typeof openMemoryTable>>): Promise<void> {
    const rowCount = await sourceTable.countRows();
    if (rowCount > 0) {
      return;
    }

    const db = await lancedb.connect(resolveLanceDbPath(this.config.lancedbPath));
    await db.dropTable(tableName);
    this.debug?.basic('embedding_migration.drop_table', { tableName });
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
    return {
      memory_uid: String(row.memory_uid || ''),
      user_id: String(row.user_id || ''),
      run_id: String(row.run_id || ''),
      scope: String(row.scope || 'long-term'),
      text: String(row.text || ''),
      categories: Array.isArray(row.categories) ? [...row.categories] : [],
      tags: Array.isArray(row.tags) ? [...row.tags] : [],
      ts_event: String(row.ts_event || new Date().toISOString()),
      source: String(row.source || 'openclaw'),
      status: String(row.status || 'active'),
      sensitivity: String(row.sensitivity || 'internal'),
      openclaw_refs: String(row.openclaw_refs || '{}'),
      mem0_id: String(row.mem0_id || ''),
      mem0_event_id: String(row.mem0_event_id || ''),
      mem0_hash: String(row.mem0_hash || ''),
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
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}
