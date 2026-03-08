import { HotMemorySearch } from '../hot/search';
import { hasMem0Auth } from '../control/auth';
import { HttpMem0Client } from '../control/mem0';
import { classifyQueryDomain, classifyQueryIntent } from '../memory/typing';
import type { MemoryDomain, PluginConfig, SearchParams, SearchResult } from '../types';

export class MemorySearchTool {
  private readonly config: PluginConfig;
  private readonly hotSearch: HotMemorySearch;

  constructor(config: PluginConfig) {
    this.config = config;
    this.hotSearch = new HotMemorySearch(config);
  }

  async execute(params: SearchParams): Promise<SearchResult> {
    const { query, userId, topK = 5, filters } = params;
    const intent = classifyQueryIntent(query);

    try {
      const result = await this.hotSearch.search({ query, userId, topK, filters });
      if (result.memories.length >= topK || !hasMem0Auth(this.config)) {
        return result;
      }

      const remote = await this.searchMem0Enhanced(query, userId, topK, filters, intent);
      return this.mergeLocalAndRemote(result, remote, topK);
    } catch (err) {
      console.warn('[memorySearch] LanceDB failed, trying Mem0 fallback:', err);
    }

    if (!hasMem0Auth(this.config)) {
      return { memories: [], source: 'none' };
    }

    try {
      return await this.searchMem0Enhanced(query, userId, topK, filters, intent);
    } catch (err) {
      console.error('[memorySearch] Mem0 also failed:', err);
      return { memories: [], source: 'none' };
    }
  }

  private async searchMem0Enhanced(
    query: string,
    userId: string,
    topK: number,
    filters?: SearchParams['filters'],
    intent?: ReturnType<typeof classifyQueryIntent>,
  ): Promise<SearchResult> {
    const client = new HttpMem0Client(this.config, fetch);
    const mem0Filters = this.buildMem0Filters(query, filters, intent || classifyQueryIntent(query));
    const memories = await client.searchMemories({
      query,
      userId,
      topK: Math.max(topK * 2, 10),
      filters: mem0Filters,
      rerank: true,
    });

    return {
      memories: memories.map((row: any) => ({
        memory_uid: row.id || row.memory_uid || `mem0-${Buffer.from(String(row.text || '')).toString('base64').slice(0, 12)}`,
        user_id: userId,
        run_id: row.run_id || null,
        scope: row.scope || 'long-term',
        text: row.memory || row.text,
        categories: row.categories || [],
        tags: row.tags || [],
        memory_type: row.memory_type || 'generic',
        domains: this.normalizeDomains(row.domains, classifyQueryDomain(query)),
        source_kind: row.source_kind || 'assistant_inferred',
        confidence: typeof row.confidence === 'number' ? row.confidence : 0.7,
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

  private buildMem0Filters(
    query: string,
    filters: SearchParams['filters'] | undefined,
    intent: ReturnType<typeof classifyQueryIntent>,
  ): Record<string, any> {
    const clauses: any[] = [];
    if (filters?.scope) {
      clauses.push({ 'metadata.scope': filters.scope });
    }
    if (filters?.categories?.length) {
      clauses.push({ categories: { in: filters.categories } });
    }
    if (filters?.memoryType) {
      clauses.push({ metadata: { memory_type: filters.memoryType } });
    }
    if (filters?.domains?.length) {
      clauses.push({ metadata: { domains: filters.domains[0] } });
    }

    if (intent === 'preference') {
      clauses.push({
        OR: [
          { metadata: { memory_type: 'preference' } },
          { categories: { in: ['preference'] } },
          { metadata: { domains: classifyQueryDomain(query) } },
        ],
      });
    } else if (intent === 'profile') {
      clauses.push({
        OR: [
          { metadata: { memory_type: 'profile' } },
          { categories: { in: ['profile'] } },
        ],
      });
    } else if (intent === 'credential') {
      clauses.push({
        OR: [
          { metadata: { memory_type: 'credential' } },
          { categories: { in: ['token', 'credential'] } },
        ],
      });
    }

    if (clauses.length === 0) {
      return {};
    }

    return { AND: clauses };
  }

  private mergeLocalAndRemote(local: SearchResult, remote: SearchResult, topK: number): SearchResult {
    const seen = new Set<string>();
    const merged = [...local.memories, ...remote.memories].filter((memory) => {
      const key = memory.memory_uid || `${memory.user_id}:${memory.text}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    return {
      memories: merged.slice(0, topK),
      source: local.memories.length > 0 ? local.source : remote.source,
    };
  }

  private normalizeDomains(domains: unknown, fallback: MemoryDomain): MemoryDomain[] {
    if (!Array.isArray(domains) || domains.length === 0) {
      return [fallback];
    }

    return domains.map((domain) => String(domain) as MemoryDomain);
  }
}
