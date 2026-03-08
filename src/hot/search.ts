import { embedText } from './embedder';
import { openMemoryTable } from '../db/table';
import { getMemoryTableName } from '../db/schema';
import * as lancedb from '@lancedb/lancedb';
import * as path from 'path';
import * as os from 'os';
import type { PluginConfig, SearchParams, SearchResult } from '../types';

const RRF_K = 60;
const MMR_LAMBDA = 0.5;
const SIMILARITY_THRESHOLD = 0.85;

export class HotMemorySearch {
  private readonly config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, userId, topK = 5, filters } = params;
    const currentDim = this.config.embedding?.dimension || 16;
    const whereClause = this.buildWhereClause(userId, filters);
    
    // 发现所有可用的记忆表
    const allTables = await this.discoverTables();
    const allRows: any[] = [];
    
    // 对每个表进行搜索
    for (const { dimension, name } of allTables) {
      const tbl = await openMemoryTable(this.config.lancedbPath, dimension);
      
      // 当前维度的表：使用向量+FTS混合搜索
      if (dimension === currentDim) {
        const fetchK = topK * 3;
        const ftsRows = await this.searchFts(tbl, query, whereClause, fetchK);
        const vectorRows = await this.searchVector(tbl, query, whereClause, fetchK);
        const merged = this.mergeRrf(ftsRows, vectorRows, fetchK);
        allRows.push(...merged.map(r => ({ ...r, _sourceDim: dimension })));
      } else {
        // 其他维度的表：仅使用FTS文本搜索（向量维度不匹配）
        const fetchK = topK * 2;
        const ftsRows = await this.searchFts(tbl, query, whereClause, fetchK);
        // 为FTS结果赋予基础分数
        const scoredFtsRows = ftsRows.map((r, idx) => ({
          ...r,
          __rrf_score: 1 / (RRF_K + idx + 1),
          _sourceDim: dimension,
        }));
        allRows.push(...scoredFtsRows);
      }
    }
    
    // 去重：按 memory_uid 保留最高分的记录
    const uniqueRows = this.deduplicateByUid(allRows);
    
    if (uniqueRows.length === 0) {
      return {
        memories: [],
        source: 'lancedb',
      };
    }
    
    // 时间衰减排序
    const ranked = this.applyTimeDecay(uniqueRows);
    
    // 如果当前维度有效，使用MMR进行多样性排序
    const currentDimRows = ranked.filter(r => r._sourceDim === currentDim);
    const otherDimRows = ranked.filter(r => r._sourceDim !== currentDim);
    
    let finalRows: any[];
    if (currentDimRows.length > 0) {
      const queryVector = await embedText(query, this.config.embedding);
      const mmrSelected = this.applyMmr(currentDimRows, queryVector, topK);
      // 如果MMR结果不够，补充其他维度的结果
      if (mmrSelected.length < topK && otherDimRows.length > 0) {
        finalRows = [...mmrSelected, ...otherDimRows.slice(0, topK - mmrSelected.length)];
      } else {
        finalRows = mmrSelected.slice(0, topK);
      }
    } else {
      // 没有当前维度的结果，直接返回其他维度的排序结果
      finalRows = ranked.slice(0, topK);
    }
    
    return {
      memories: finalRows.map((row) => this.toMemoryRecord(row, row._sourceDim || currentDim)),
      source: 'lancedb',
    };
  }
  
  private async discoverTables(): Promise<Array<{ dimension: number; name: string }>> {
    const resolvedPath = this.config.lancedbPath.startsWith('~/')
      ? path.join(os.homedir(), this.config.lancedbPath.slice(2))
      : this.config.lancedbPath;
    
    const db = await lancedb.connect(resolvedPath);
    const tableNames = await db.tableNames();
    
    const tables: Array<{ dimension: number; name: string }> = [];
    
    for (const name of tableNames) {
      if (name === 'memory_records') {
        tables.push({ dimension: 16, name });
      } else if (name.startsWith('memory_records_d')) {
        const dimMatch = name.match(/memory_records_d(\d+)/);
        if (dimMatch) {
          tables.push({ dimension: parseInt(dimMatch[1], 10), name });
        }
      }
    }
    
    // 按维度排序，当前维度的表优先
    const currentDim = this.config.embedding?.dimension || 16;
    tables.sort((a, b) => {
      if (a.dimension === currentDim) return -1;
      if (b.dimension === currentDim) return 1;
      return b.dimension - a.dimension; // 高维度优先
    });
    
    return tables;
  }
  
  private deduplicateByUid(rows: any[]): any[] {
    const seen = new Map<string, any>();
    
    for (const row of rows) {
      const uid = row.memory_uid;
      if (!uid) continue;
      
      const existing = seen.get(uid);
      if (!existing || (row.__rrf_score || 0) > (existing.__rrf_score || 0)) {
        seen.set(uid, row);
      }
    }
    
    return Array.from(seen.values());
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
      const queryVector = await embedText(query, this.config.embedding);
      return await (tbl as any)
        .search(queryVector)
        .where(whereClause)
        .limit(topK)
        .toArray();
    } catch {
      return [];
    }
  }

  private mergeRrf(ftsRows: any[], vectorRows: any[], topK: number): any[] {
    const scored = new Map<string, { row: any; score: number }>();

    this.addRrfScores(scored, ftsRows);
    this.addRrfScores(scored, vectorRows);

    return Array.from(scored.values())
      .map((entry) => ({ ...entry.row, __rrf_score: entry.score }))
      .sort((left, right) => right.__rrf_score - left.__rrf_score)
      .slice(0, topK);
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

  private applyTimeDecay(rows: any[]): any[] {
    const now = Date.now();
    return rows.map((r) => {
      let ageMs = now - new Date(r.ts_event).getTime();
      if (isNaN(ageMs) || ageMs < 0) ageMs = 0;
      const decay = Math.exp(-ageMs / (1000 * 60 * 60 * 24 * 30)); // 30-day half-life roughly
      const baseScore = r.__rrf_score || 1;
      return {
        ...r,
        __final_score: baseScore * (0.8 + 0.2 * decay),
      };
    }).sort((a, b) => b.__final_score - a.__final_score);
  }

  private applyMmr(rows: any[], queryVector: number[], topK: number): any[] {
    if (rows.length === 0) return [];
    
    const selected: any[] = [];
    const candidates = [...rows];

    while (selected.length < topK && candidates.length > 0) {
      let bestIdx = -1;
      let bestScore = -Infinity;

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        
        // relevance to query
        const rel = candidate.__final_score; 
        
        let maxSim = 0;
        for (const sel of selected) {
          const sim = this.cosineSimilarity(candidate.vector || [], sel.vector || []);
          if (sim > maxSim) maxSim = sim;
        }

        const mmrScore = MMR_LAMBDA * rel - (1 - MMR_LAMBDA) * maxSim;

        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIdx = i;
        }
      }

      if (bestIdx !== -1) {
        const chosen = candidates.splice(bestIdx, 1)[0];
        // simple deduplication cutoff
        let isTooSimilar = false;
        for (const sel of selected) {
          if (this.cosineSimilarity(chosen.vector || [], sel.vector || []) > SIMILARITY_THRESHOLD) {
            isTooSimilar = true;
            break;
          }
        }
        
        if (!isTooSimilar) {
          selected.push(chosen);
        }
      } else {
        break;
      }
    }

    return selected;
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

  private toMemoryRecord(row: any, dim: number) {
    return {
      memory_uid: row.memory_uid,
      user_id: row.user_id,
      run_id: row.run_id || null,
      scope: row.scope,
      text: row.text,
      categories: Array.isArray(row.categories) ? row.categories : [],
      tags: Array.isArray(row.tags) ? row.tags : [],
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
        table: getMemoryTableName(dim),
        row_key: row.lancedb_row_key || row.memory_uid,
        vector_dim: Array.isArray(row.vector) ? row.vector.length : null,
        index_version: 'rrf-v1',
      },
    };
  }

  private parseJsonObj(value: string): Record<string, any> {
    try {
      return JSON.parse(value || '{}');
    } catch {
      return {};
    }
  }
}
