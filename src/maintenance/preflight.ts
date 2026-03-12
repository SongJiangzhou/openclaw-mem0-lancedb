import { promises as fs } from 'node:fs';

import type { PluginConfig } from '../types';
import { discoverMemoryTables } from '../hot/table-discovery';
import type { MemoryAdapter } from '../bridge/adapter';

export type MaintenancePreflight = {
  pendingSync: boolean;
  legacyEmbeddingTables: number;
  consolidationCandidates: number;
  lifecycleCandidates: number;
};

export async function collectMaintenancePreflight(
  config: PluginConfig,
  adapter: MemoryAdapter,
): Promise<MaintenancePreflight> {
  const tables = await safeDiscoverMemoryTables(config);
  const hasMemoryTables = tables.length > 0;
  const [pendingSync, consolidationCandidates, lifecycleCandidates] = await Promise.all([
    hasPendingOutbox(config.outboxDbPath),
    hasMemoryTables ? countConsolidationCandidates(adapter) : Promise.resolve(0),
    hasMemoryTables ? countLifecycleCandidates(adapter) : Promise.resolve(0),
  ]);
  const currentDim = config.embedding?.dimension || 16;
  const legacyEmbeddingTables = tables.filter((table) => table.name.includes('_legacy_') || table.dimension !== currentDim).length;

  return {
    pendingSync,
    legacyEmbeddingTables,
    consolidationCandidates,
    lifecycleCandidates,
  };
}

async function hasPendingOutbox(filePath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { items?: Array<{ status?: string }> };
    return Array.isArray(parsed.items) && parsed.items.some((item) => item?.status === 'pending');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function countConsolidationCandidates(adapter: MemoryAdapter): Promise<number> {
  const rows = await adapter.listMemories({ status: 'active', scope: 'long-term' });
  const seen = new Set<string>();
  let candidates = 0;
  for (const row of rows) {
    const key = `${row.memory.user_id}::${normalizeText(row.memory.text)}`;
    if (seen.has(key)) {
      candidates += 1;
      continue;
    }
    seen.add(key);
  }
  return candidates;
}

async function countLifecycleCandidates(adapter: MemoryAdapter): Promise<number> {
  const rows = await adapter.listMemories({ status: 'active' });
  return rows.filter((row) => row.memory.scope === 'session' || row.memory.lifecycle_state === 'inhibited').length;
}

function normalizeText(value: string): string {
  return String(value || '').trim().toLowerCase();
}

async function safeDiscoverMemoryTables(config: PluginConfig) {
  try {
    return await discoverMemoryTables(config.lancedbPath, config.embedding?.dimension || 16);
  } catch {
    return [];
  }
}
