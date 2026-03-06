import { HttpMem0Client } from '../control/mem0';
import { HotMemorySearch } from '../hot/search';
import type { PluginConfig, SearchParams, SearchResult } from '../types';

export class MemorySearchTool {
  private readonly config: PluginConfig;
  private readonly hotSearch: HotMemorySearch;

  constructor(config: PluginConfig) {
    this.config = config;
    this.hotSearch = new HotMemorySearch(config);
  }

  async execute(params: SearchParams): Promise<SearchResult> {
    const { query, userId, topK = 5, filters } = params;

    try {
      const result = await this.hotSearch.search({ query, userId, topK, filters });
      if (result.memories.length > 0) {
        return result;
      }
    } catch (err) {
      console.warn('[memorySearch] LanceDB failed, trying Mem0 fallback:', err);
    }

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

  private async searchMem0(
    query: string,
    userId: string,
    topK: number,
    filters?: SearchParams['filters'],
  ): Promise<SearchResult> {
    const client = new HttpMem0Client(this.config);
    const response = await fetch(`${this.config.mem0BaseUrl}/v1/memories/search/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${this.config.mem0ApiKey}`,
      },
      body: JSON.stringify({ query, user_id: userId, top_k: topK, filters: filters || {} }),
    });
    if (!response.ok) {
      throw new Error(`Mem0 search failed: ${response.status}`);
    }

    const data: any = await response.json();
    void client;

    return {
      memories: (data.results || []).map((row: any) => ({
        memory_uid: row.id || row.memory_uid,
        user_id: userId,
        run_id: row.run_id || null,
        scope: row.scope || 'long-term',
        text: row.memory || row.text,
        categories: row.categories || [],
        tags: row.tags || [],
        ts_event: row.created_at || new Date().toISOString(),
        source: 'openclaw' as const,
        status: 'active' as const,
        sensitivity: 'internal' as const,
        openclaw_refs: row.openclaw_refs || {},
        mem0: {
          mem0_id: row.id || null,
          event_id: row.event_id || null,
          hash: row.hash || null,
        },
        lancedb: {
          table: null,
          row_key: null,
          vector_dim: null,
          index_version: null,
        },
      })),
      source: 'mem0',
    };
  }
}
