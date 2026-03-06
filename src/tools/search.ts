import { PluginConfig, SearchParams, SearchResult } from '../types';
import { openMemoryTable } from '../db/table';

export class MemorySearchTool {
  private config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  async execute(params: SearchParams): Promise<SearchResult> {
    const { query, userId, topK = 5, filters } = params;

    try {
      // 优先走 LanceDB
      const result = await this.searchLanceDB(query, userId, topK, filters);
      if (result.memories.length > 0) return result;
    } catch (err) {
      console.warn('[memorySearch] LanceDB failed, trying Mem0 fallback:', err);
    }

    // Mem0 fallback（需要 apiKey）
    if (!this.config.mem0ApiKey) {
      return { memories: [], source: 'none' };
    }

    try {
      return await this.searchMem0(query, userId, topK, filters);
    } catch (err) {
      console.error('[memorySearch] Mem0 also failed:', err);
      return { memories: [], source: 'none' };
    }
  }

  private async searchLanceDB(
    query: string,
    userId: string,
    topK: number,
    filters?: SearchParams['filters']
  ): Promise<SearchResult> {
    const tbl = await openMemoryTable(this.config.lancedbPath);

    // 构建过滤条件
    let whereClause = `user_id = '${userId}' AND status = 'active'`;
    if (filters?.scope) whereClause += ` AND scope = '${filters.scope}'`;
    if (filters?.status) whereClause = `user_id = '${userId}' AND status = '${filters.status}'`;

    let rows: any[] = [];

    try {
      // 尝试 FTS 检索
      rows = await (tbl as any)
        .search(query, 'fts', 'text')
        .where(whereClause)
        .limit(topK)
        .toArray();
    } catch {
      // FTS 索引不存在或未建立，降级为全量过滤
      rows = await tbl.query().where(whereClause).limit(topK).toArray();
      // 简单文本包含过滤
      const q = query.toLowerCase();
      rows = rows.filter((r: any) => (r.text || '').toLowerCase().includes(q));
    }

    const memories = rows.map((r: any) => ({
      memory_uid: r.memory_uid,
      user_id: r.user_id,
      scope: r.scope,
      text: r.text,
      categories: this.parseJsonArray(r.categories),
      ts_event: r.ts_event,
      source: 'openclaw' as const,
      status: r.status,
      openclaw_refs: this.parseJsonObj(r.openclaw_refs),
    }));

    return { memories, source: 'lancedb' };
  }

  private async searchMem0(
    query: string,
    userId: string,
    topK: number,
    filters?: SearchParams['filters']
  ): Promise<SearchResult> {
    const url = `${this.config.mem0BaseUrl}/v1/memories/search/`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${this.config.mem0ApiKey}` },
      body: JSON.stringify({ query, user_id: userId, top_k: topK, filters: filters || {} })
    });
    if (!response.ok) throw new Error(`Mem0 search failed: ${response.status}`);
    const data: any = await response.json();
    const memories = (data.results || []).map((r: any) => ({
      memory_uid: r.id || r.memory_uid,
      user_id: userId,
      scope: r.scope || 'long-term',
      text: r.memory || r.text,
      categories: r.categories || [],
      ts_event: r.created_at || new Date().toISOString(),
      source: 'openclaw',
      status: 'active',
    }));
    return { memories, source: 'mem0' };
  }

  private parseJsonArray(s: string): string[] {
    try { return JSON.parse(s || '[]'); } catch { return []; }
  }

  private parseJsonObj(s: string): Record<string, any> {
    try { return JSON.parse(s || '{}'); } catch { return {}; }
  }
}
