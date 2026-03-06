import { embedText } from './embedder';
import { openMemoryTable } from '../db/table';
import type { PluginConfig, SearchParams, SearchResult } from '../types';

const RRF_K = 60;

export class HotMemorySearch {
  private readonly config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, userId, topK = 5, filters } = params;
    const tbl = await openMemoryTable(this.config.lancedbPath);
    const whereClause = this.buildWhereClause(userId, filters);
    const ftsRows = await this.searchFts(tbl, query, whereClause, topK);
    const vectorRows = await this.searchVector(tbl, query, whereClause, topK);
    const rows = this.mergeRrf(ftsRows, vectorRows, topK);

    if (rows.length === 0) {
      const fallbackRows = await tbl.query().where(whereClause).limit(topK).toArray();
      const needle = query.toLowerCase();
      return {
        memories: fallbackRows
          .filter((row: any) => String(row.text || '').toLowerCase().includes(needle))
          .map((row: any) => this.toMemoryRecord(row)),
        source: 'lancedb',
      };
    }

    return {
      memories: rows.map((row) => this.toMemoryRecord(row)),
      source: 'lancedb',
    };
  }

  private buildWhereClause(userId: string, filters?: SearchParams['filters']): string {
    let whereClause = `user_id = '${userId}' AND status = 'active'`;
    if (filters?.scope) {
      whereClause += ` AND scope = '${filters.scope}'`;
    }
    if (filters?.status) {
      whereClause = `user_id = '${userId}' AND status = '${filters.status}'`;
    }
    return whereClause;
  }

  private async searchFts(tbl: Awaited<ReturnType<typeof openMemoryTable>>, query: string, whereClause: string, topK: number): Promise<any[]> {
    try {
      return await (tbl as any)
        .search(query, 'fts', 'text')
        .where(whereClause)
        .limit(topK)
        .toArray();
    } catch {
      return [];
    }
  }

  private async searchVector(tbl: Awaited<ReturnType<typeof openMemoryTable>>, query: string, whereClause: string, topK: number): Promise<any[]> {
    try {
      const queryVector = embedText(query);
      const rows = await tbl.query().where(whereClause).limit(Math.max(topK * 4, topK)).toArray();
      return rows
        .map((row: any) => ({ ...row, __score: this.cosineSimilarity(queryVector, row.vector || []) }))
        .sort((left: any, right: any) => right.__score - left.__score)
        .slice(0, topK);
    } catch {
      return [];
    }
  }

  private mergeRrf(ftsRows: any[], vectorRows: any[], topK: number): any[] {
    const scored = new Map<string, { row: any; score: number }>();

    this.addRrfScores(scored, ftsRows);
    this.addRrfScores(scored, vectorRows);

    return Array.from(scored.values())
      .sort((left, right) => right.score - left.score)
      .slice(0, topK)
      .map((entry) => entry.row);
  }

  private addRrfScores(scored: Map<string, { row: any; score: number }>, rows: any[]): void {
    rows.forEach((row, index) => {
      const key = row.memory_uid;
      const rank = index + 1;
      const rrf = 1 / (RRF_K + rank);
      const existing = scored.get(key);

      if (existing) {
        existing.score += rrf;
      } else {
        scored.set(key, { row, score: rrf });
      }
    });
  }

  private cosineSimilarity(left: number[], right: number[]): number {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || right.length === 0) {
      return 0;
    }

    const length = Math.min(left.length, right.length);
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;

    for (let index = 0; index < length; index += 1) {
      const l = Number(left[index] || 0);
      const r = Number(right[index] || 0);
      dot += l * r;
      leftNorm += l * l;
      rightNorm += r * r;
    }

    if (leftNorm === 0 || rightNorm === 0) {
      return 0;
    }

    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  }

  private toMemoryRecord(row: any) {
    return {
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
        vector_dim: Array.isArray(row.vector) ? row.vector.length : null,
        index_version: 'rrf-v1',
      },
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
