import { openMemoryTable } from '../db/table';
import type { PluginConfig, SearchParams, SearchResult } from '../types';

export class HotMemorySearch {
  private readonly config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, userId, topK = 5, filters } = params;
    const tbl = await openMemoryTable(this.config.lancedbPath);

    let whereClause = `user_id = '${userId}' AND status = 'active'`;
    if (filters?.scope) {
      whereClause += ` AND scope = '${filters.scope}'`;
    }
    if (filters?.status) {
      whereClause = `user_id = '${userId}' AND status = '${filters.status}'`;
    }

    let rows: any[] = [];

    try {
      rows = await (tbl as any)
        .search(query, 'fts', 'text')
        .where(whereClause)
        .limit(topK)
        .toArray();
    } catch {
      rows = [];
    }

    if (rows.length === 0) {
      rows = await tbl.query().where(whereClause).limit(topK).toArray();
      const needle = query.toLowerCase();
      rows = rows.filter((row: any) => String(row.text || '').toLowerCase().includes(needle));
    }

    return {
      memories: rows.map((row: any) => ({
        memory_uid: row.memory_uid,
        user_id: row.user_id,
        run_id: row.run_id || null,
        scope: row.scope,
        text: row.text,
        categories: this.parseJsonArray(row.categories),
        tags: this.parseJsonArray(row.tags),
        ts_event: row.ts_event,
        source: 'openclaw' as const,
        status: row.status,
        sensitivity: row.sensitivity,
        openclaw_refs: this.parseJsonObj(row.openclaw_refs),
        mem0: {
          mem0_id: row.mem0_id || null,
          event_id: row.mem0_event_id || null,
          hash: row.mem0_hash || null,
        },
        lancedb: {
          table: 'memory_records',
          row_key: row.lancedb_row_key || row.memory_uid,
          vector_dim: null,
          index_version: null,
        },
      })),
      source: 'lancedb',
    };
  }

  private parseJsonArray(value: string): string[] {
    try {
      return JSON.parse(value || '[]');
    } catch {
      return [];
    }
  }

  private parseJsonObj(value: string): Record<string, any> {
    try {
      return JSON.parse(value || '{}');
    } catch {
      return {};
    }
  }
}
