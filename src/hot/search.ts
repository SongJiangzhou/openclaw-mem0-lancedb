import { embedText } from './embedder';
import { discoverMemoryTables } from './table-discovery';
import { openMemoryTable } from '../db/table';
import { getMemoryTableName } from '../db/schema';
import { buildMemoryDedupKeys } from '../memory/dedup';
import { backfillLifecycleFields, isRecallEligibleLifecycleState } from '../memory/lifecycle';
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
const MIN_FINAL_SCORE = 0.25;
const LENGTH_PENALTY_REFERENCE_CHARS = 96;
const LENGTH_PENALTY_SCALE = 0.35;
const CONFIDENCE_BOOST_SCALE = 0.6;
const SOURCE_KIND_WEIGHT: Record<string, number> = {
  user_explicit: 0.2,
  imported: 0.1,
  assistant_inferred: 0,
  system_generated: -0.2,
};

export class HotMemorySearch {
  private readonly config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const { query, userId, topK = 5, filters } = params;
    const currentDim = this.config.embedding?.dimension || 16;
    const whereClause = this.buildWhereClause(userId, filters);
    let queryVector: number[] | null | undefined;
    
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
        queryVector = queryVector === undefined ? await this.getQueryVector(query) : queryVector;
        const vectorRows = await this.searchVector(tbl, queryVector, whereClause, fetchK);
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
    
    // 去重：按 mem0_hash / 规范化文本 折叠同语义记录
    const uniqueRows = this.deduplicateRows(allRows)
      .map((row) => backfillLifecycleFields(row))
      .filter((row) => this.isRecallEligibleRow(row));
    
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
      try {
        queryVector = queryVector === undefined ? await this.getQueryVector(query) : queryVector;
        if (!queryVector) {
          throw new Error('query embedding unavailable');
        }
        const mmrSelected = this.applyMmr(currentDimRows, queryVector, topK);
        // 如果MMR结果不够，补充其他维度的结果
        if (mmrSelected.length < topK && otherDimRows.length > 0) {
          finalRows = [...mmrSelected, ...otherDimRows.slice(0, topK - mmrSelected.length)];
        } else {
          finalRows = mmrSelected.slice(0, topK);
        }
      } catch (error) {
        console.warn('[hot/search] MMR query embedding failed, falling back to ranked rows:', this.describeError(error));
        finalRows = ranked.slice(0, topK);
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
  
  private deduplicateRows(rows: any[]): any[] {
    const aliasToCanonical = new Map<string, string>();
    const canonicalRows = new Map<string, any>();
    let anonymousIndex = 0;

    for (const row of rows) {
      const dedupKeys = buildMemoryDedupKeys({ text: row.text, mem0_hash: row.mem0_hash });
      const existingCanonicalId = dedupKeys.map((key) => aliasToCanonical.get(key)).find(Boolean);
      const fallbackId = String(row.memory_uid || `row-${anonymousIndex++}`);
      const canonicalId = existingCanonicalId || fallbackId;
      const existingRow = canonicalRows.get(canonicalId);

      if (!existingRow || this.isHigherPriorityRow(row, existingRow)) {
        canonicalRows.set(canonicalId, row);
      }

      if (dedupKeys.length === 0) {
        aliasToCanonical.set(fallbackId, canonicalId);
      } else {
        dedupKeys.forEach((key) => aliasToCanonical.set(key, canonicalId));
      }
    }

    return Array.from(canonicalRows.values());
  }

  private isHigherPriorityRow(candidate: any, existing: any): boolean {
    const candidateScore = candidate.__rrf_score || candidate.__final_score || 0;
    const existingScore = existing.__rrf_score || existing.__final_score || 0;
    if (candidateScore !== existingScore) {
      return candidateScore > existingScore;
    }

    return String(candidate.ts_event || '') > String(existing.ts_event || '');
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

  private async searchVector(tbl: Awaited<ReturnType<typeof openMemoryTable>>, queryVector: number[] | null, whereClause: string, topK: number): Promise<any[]> {
    if (!queryVector) {
      return [];
    }

    try {
      return await (tbl as any)
        .search(queryVector)
        .where(whereClause)
        .limit(topK)
        .toArray();
    } catch (error) {
      console.warn('[hot/search] Vector search skipped because query embedding failed:', this.describeError(error));
      return [];
    }
  }

  private async getQueryVector(query: string): Promise<number[] | null> {
    try {
      return await embedText(query, this.config.embedding);
    } catch (error) {
      console.warn('[hot/search] Query embedding failed:', this.describeError(error));
      return null;
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
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
      let ageMs = now - new Date(r.last_access_ts || r.ts_event).getTime();
      if (isNaN(ageMs) || ageMs < 0) ageMs = 0;
      const stabilityDays = typeof r.stability === 'number' && r.stability > 0 ? r.stability : 30;
      const decay = Math.exp(-Math.log(2) * (ageMs / (1000 * 60 * 60 * 24)) / stabilityDays);
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
      const lengthPenalty = this.computeLengthPenalty(String(r.text || ''));
      const evidenceBoost = this.computeEvidenceBoost(r);

      const lifecycleBoost = this.computeLifecycleBoost(r, decay);

      return {
        ...r,
        __final_score: baseScore * lifecycleBoost + lexicalBoost + intentBoost + evidenceBoost - noisePenalty - lengthPenalty,
      };
    }).filter((row) => row.__final_score >= MIN_FINAL_SCORE)
      .sort((a, b) => b.__final_score - a.__final_score);
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

  private computeLengthPenalty(text: string): number {
    const length = String(text || '').trim().length;
    if (length <= LENGTH_PENALTY_REFERENCE_CHARS) {
      return 0;
    }

    const ratio = length / LENGTH_PENALTY_REFERENCE_CHARS;
    return Math.log2(ratio) * LENGTH_PENALTY_SCALE;
  }

  private computeEvidenceBoost(row: any): number {
    const confidence = typeof row?.confidence === 'number' ? Math.max(0, Math.min(1, row.confidence)) : 0.7;
    const confidenceBoost = (confidence - 0.5) * CONFIDENCE_BOOST_SCALE;
    const sourceKind = String(row?.source_kind || '');
    const sourceBoost = SOURCE_KIND_WEIGHT[sourceKind] ?? 0;
    return confidenceBoost + sourceBoost;
  }

  private computeNoisePenalty(row: any, normalizedQuery: string, tokenQuery: boolean): number {
    const text = String(row?.text || '');
    const normalizedText = this.normalizeText(text);
    const categories = this.listFieldToStrings(row?.categories).map((item) => this.normalizeText(item));
    const exactQueryHit = Boolean(normalizedQuery) && normalizedText.includes(normalizedQuery);
    let penalty = 0;

    if (this.isMetadataNoise(normalizedText, categories)) {
      penalty += METADATA_NOISE_PENALTY;
    }

    if (!tokenQuery && this.isCredentialTestNoise(normalizedText, categories, exactQueryHit)) {
      penalty += CREDENTIAL_TEST_NOISE_PENALTY;
    }

    if (this.isSystemTraceNoise(normalizedText, categories, normalizedQuery)) {
      penalty += SYSTEM_TRACE_NOISE_PENALTY;
    }

    return penalty;
  }

  private isRecallEligibleRow(row: any): boolean {
    if (!isRecallEligibleLifecycleState(String(row.lifecycle_state || ''))) {
      return false;
    }

    const deadline = String(row.retention_deadline || '');
    if (!deadline) {
      return true;
    }

    const deadlineTs = new Date(deadline).getTime();
    return Number.isNaN(deadlineTs) || deadlineTs >= Date.now();
  }

  private computeLifecycleBoost(row: any, decay: number): number {
    const hasLifecycleState =
      typeof row?.lifecycle_state === 'string'
      || typeof row?.strength === 'number'
      || typeof row?.utility_score === 'number'
      || typeof row?.stability === 'number';

    if (!hasLifecycleState) {
      return 0.8 + (0.2 * decay);
    }

    const strength = typeof row?.strength === 'number' ? row.strength : 0.6;
    const utility = typeof row?.utility_score === 'number' ? row.utility_score : 0.5;
    const inhibitionWeight = typeof row?.inhibition_weight === 'number' ? row.inhibition_weight : 0;
    const inhibitionUntil = String(row?.inhibition_until || '');
    const inhibitionActive = inhibitionUntil ? new Date(inhibitionUntil).getTime() > Date.now() : false;
    const lifecycleState = String(row?.lifecycle_state || 'active');
    let multiplier = 0.75 + (0.25 * decay) + (0.35 * strength) + (0.2 * utility);

    if (lifecycleState === 'reinforced') {
      multiplier += 0.2;
    }
    if (lifecycleState === 'inhibited' || inhibitionActive) {
      multiplier -= Math.max(0.4, inhibitionWeight);
    }

    return Math.max(0.1, multiplier);
  }

  private isMetadataNoise(text: string, categories: string[]): boolean {
    return (
      categories.includes('metadata') ||
      /sender \(untrusted metadata\)|client metadata payload|gateway-client|label .*username|username .*id /.test(text)
    );
  }

  private isCredentialTestNoise(text: string, categories: string[], exactQueryHit: boolean): boolean {
    if (exactQueryHit) {
      return false;
    }

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
      lifecycle_state: row.lifecycle_state,
      strength: typeof row.strength === 'number' ? row.strength : undefined,
      stability: typeof row.stability === 'number' ? row.stability : undefined,
      last_access_ts: row.last_access_ts || undefined,
      next_review_ts: row.next_review_ts || undefined,
      access_count: typeof row.access_count === 'number' ? row.access_count : undefined,
      inhibition_weight: typeof row.inhibition_weight === 'number' ? row.inhibition_weight : undefined,
      inhibition_until: row.inhibition_until || undefined,
      utility_score: typeof row.utility_score === 'number' ? row.utility_score : undefined,
      risk_score: typeof row.risk_score === 'number' ? row.risk_score : undefined,
      retention_deadline: row.retention_deadline || undefined,
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
