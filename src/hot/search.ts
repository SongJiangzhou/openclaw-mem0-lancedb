import { embedText } from './embedder';
import { discoverMemoryTables } from './table-discovery';
import { openMemoryTable } from '../db/table';
import { getMemoryTableName } from '../db/schema';
import { classifyQueryDomain, classifyQueryIntent, inferMemoryAnnotations, looksLikeCredentialQuery } from '../memory/typing';
import type { MemoryDomain, MemoryRecord, PluginConfig, SearchParams, SearchResult } from '../types';

const RRF_K = 60;
const MMR_LAMBDA = 0.5;
const SIMILARITY_THRESHOLD = 0.85;
const EXACT_QUERY_MATCH_BOOST = 1.0;
const STRUCTURED_TOKEN_BOOST = 0.75;
const PREFERENCE_INTENT_BOOST = 0.9;
const DOMAIN_MATCH_BOOST = 0.6;
const PROFILE_INTENT_BOOST = 0.75;
const RECENCY_INTENT_BOOST = 0.4;
const METADATA_NOISE_PENALTY = 1.25;
const CREDENTIAL_TEST_NOISE_PENALTY = 1.0;
const SYSTEM_TRACE_NOISE_PENALTY = 0.75;

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
    const allTables = await discoverMemoryTables(this.config.lancedbPath, currentDim);
    const allRows: any[] = [];
    
    // 对每个表进行搜索
    for (const { dimension, name } of allTables) {
      const tbl = await openMemoryTable(this.config.lancedbPath, dimension);
      
      // 当前维度的表：使用向量+FTS混合搜索
      if (dimension === currentDim) {
        const fetchK = Math.max(topK * 6, 24);
        const ftsRows = await this.searchFts(tbl, query, whereClause, fetchK);
        const vectorRows = await this.searchVector(tbl, query, whereClause, fetchK);
        const merged = this.mergeRrf(ftsRows, vectorRows, fetchK);
        allRows.push(...merged.map(r => ({ ...r, _sourceDim: dimension })));
      } else {
        // 其他维度的表：仅使用FTS文本搜索（向量维度不匹配）
        const fetchK = Math.max(topK * 4, 16);
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
    
    // 时间衰减 + lexical boosts
    const ranked = this.applyRankingAdjustments(uniqueRows, query);
    
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

  private applyRankingAdjustments(rows: any[], query: string): any[] {
    const now = Date.now();
    const normalizedQuery = this.normalizeText(query);
    const tokenQuery = looksLikeCredentialQuery(normalizedQuery);
    const queryIntent = classifyQueryIntent(normalizedQuery);
    const queryDomain = classifyQueryDomain(normalizedQuery);

    return rows.map((r) => {
      let ageMs = now - new Date(r.ts_event).getTime();
      if (isNaN(ageMs) || ageMs < 0) ageMs = 0;
      const decay = Math.exp(-ageMs / (1000 * 60 * 60 * 24 * 30)); // 30-day half-life roughly
      const baseScore = r.__rrf_score || 1;
      const text = this.normalizeText(r.text || '');
      let lexicalBoost = 0;

      if (normalizedQuery && text.includes(normalizedQuery)) {
        lexicalBoost += EXACT_QUERY_MATCH_BOOST;
      }

      if (tokenQuery && this.containsStructuredToken(String(r.text || ''))) {
        lexicalBoost += STRUCTURED_TOKEN_BOOST;
      }

      const intentBoost = this.computeIntentBoost(r, queryIntent, queryDomain, decay);
      const noisePenalty = this.computeNoisePenalty(r, normalizedQuery, tokenQuery);

      return {
        ...r,
        __final_score: baseScore * (0.8 + 0.2 * decay) + lexicalBoost + intentBoost - noisePenalty,
      };
    }).sort((a, b) => b.__final_score - a.__final_score);
  }

  private normalizeText(value: string): string {
    return String(value || '').trim().toLowerCase();
  }

  private containsStructuredToken(text: string): boolean {
    return /[a-z0-9]+(?:-[a-z0-9]+){2,}/i.test(text);
  }

  private computeIntentBoost(row: any, queryIntent: ReturnType<typeof classifyQueryIntent>, queryDomain: ReturnType<typeof classifyQueryDomain>, decay: number): number {
    const annotations = inferMemoryAnnotations({
      text: String(row?.text || ''),
      categories: this.listFieldToStrings(row?.categories),
      sourceKind: row?.source_kind,
      confidence: typeof row?.confidence === 'number' ? row.confidence : undefined,
    });
    const memoryType = String(row.memory_type || annotations.memoryType);
    const memoryDomains = this.listFieldToStrings(row.domains);
    const normalizedDomains = memoryDomains.length > 0 ? memoryDomains : annotations.domains;
    let boost = 0;

    if (queryIntent === 'preference' && memoryType === 'preference') {
      boost += PREFERENCE_INTENT_BOOST;
      if (queryDomain !== 'generic' && normalizedDomains.includes(queryDomain)) {
        boost += DOMAIN_MATCH_BOOST;
      }
    }

    if (queryIntent === 'profile' && memoryType === 'profile') {
      boost += PROFILE_INTENT_BOOST;
    }

    if (queryIntent === 'recency') {
      boost += RECENCY_INTENT_BOOST * decay;
    }

    if (queryIntent === 'credential' && memoryType === 'credential') {
      boost += STRUCTURED_TOKEN_BOOST;
    }

    return boost;
  }

  private computeNoisePenalty(row: any, normalizedQuery: string, tokenQuery: boolean): number {
    const text = String(row?.text || '');
    const normalizedText = this.normalizeText(text);
    const categories = this.listFieldToStrings(row?.categories).map((item) => this.normalizeText(item));
    let penalty = 0;

    if (this.isMetadataNoise(normalizedText, categories)) {
      penalty += METADATA_NOISE_PENALTY;
    }

    if (!tokenQuery && this.isCredentialTestNoise(normalizedText, categories)) {
      penalty += CREDENTIAL_TEST_NOISE_PENALTY;
    }

    if (this.isSystemTraceNoise(normalizedText, categories, normalizedQuery)) {
      penalty += SYSTEM_TRACE_NOISE_PENALTY;
    }

    return penalty;
  }

  private isMetadataNoise(text: string, categories: string[]): boolean {
    return (
      categories.includes('metadata') ||
      /sender \(untrusted metadata\)|client metadata payload|gateway-client|label .*username|username .*id /.test(text)
    );
  }

  private isCredentialTestNoise(text: string, categories: string[]): boolean {
    return (
      categories.includes('token') ||
      categories.includes('credential') ||
      /\b(test|integration test|e2e)\b/.test(text) &&
        /\b(token|password|passcode|verification code|secret|api key)\b/.test(text)
    );
  }

  private isSystemTraceNoise(text: string, categories: string[], normalizedQuery: string): boolean {
    if (/(capture|recall|poller|debug|sync|eventid|plugin\.register)/.test(normalizedQuery)) {
      return false;
    }

    return (
      categories.includes('system') ||
      categories.includes('debug') ||
      /\b(plugin|poller|capture|recall|debug|sync(ed)? memory|integration check)\b/.test(text)
    );
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

  private toMemoryRecord(row: any, dim: number): MemoryRecord {
    const domains = this.listFieldToStrings(row.domains) as MemoryDomain[];
    return {
      memory_uid: row.memory_uid,
      user_id: row.user_id,
      run_id: row.run_id || null,
      scope: row.scope,
      text: row.text,
      categories: this.listFieldToStrings(row.categories),
      tags: this.listFieldToStrings(row.tags),
      memory_type: row.memory_type || 'generic',
      domains: domains.length > 0 ? domains : ['generic'],
      source_kind: row.source_kind || 'user_explicit',
      confidence: typeof row.confidence === 'number' ? row.confidence : 0.7,
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

  private listFieldToStrings(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.map((item) => String(item));
    }
    if (value && typeof (value as any).toArray === 'function') {
      return (value as any).toArray().map((item: any) => String(item));
    }
    if (value && typeof (value as any).length === 'number' && typeof (value as any).get === 'function') {
      const items: string[] = [];
      for (let index = 0; index < (value as any).length; index += 1) {
        items.push(String((value as any).get(index)));
      }
      return items;
    }
    return [];
  }
}
