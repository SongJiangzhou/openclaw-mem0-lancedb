import { HotMemorySearch } from '../hot/search';
import { hasMem0Auth } from '../control/auth';
import { HttpMem0Client } from '../control/mem0';
import { buildMemoryDedupKeys } from '../memory/dedup';
import { getScopedMemoryIdentity } from '../memory/user-space';
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
    const { query, topK = 5, filters } = params;
    const identity = getScopedMemoryIdentity({
      scope: filters?.scope === 'session' ? 'session' : 'long-term',
      userId: params.userId,
      sessionId: params.sessionId,
      agentId: params.agentId,
    });
    const intent = classifyQueryIntent(query);
    let localResult: SearchResult | null = null;

    try {
      localResult = await this.hotSearch.search({
        query,
        userId: identity.userId,
        sessionId: identity.sessionId,
        agentId: identity.agentId,
        topK,
        filters,
      });
    } catch (err) {
      this.logStructuredException('memory_search.local_failed', {
        query,
        topK,
        localCount: 0,
        mem0Mode: this.config.mem0Mode,
        message: err instanceof Error ? err.message : String(err),
        cause: err instanceof Error && err.cause ? String(err.cause) : undefined,
      });
    }

    if (localResult && (localResult.memories.length >= topK || !hasMem0Auth(this.config))) {
      return localResult;
    }

    if (localResult) {
      try {
        const remote = await this.searchMem0Enhanced(query, identity.userId, topK, filters, intent);
        return this.mergeLocalAndRemote(localResult, remote, topK);
      } catch (err) {
        this.logStructuredException('memory_search.mem0_fallback_failed', {
          query,
          topK,
          localCount: localResult.memories.length,
          mem0Mode: this.config.mem0Mode,
          message: err instanceof Error ? err.message : String(err),
          cause: err instanceof Error && err.cause ? String(err.cause) : undefined,
        });
        console.warn(JSON.stringify({
          event: 'memory_search.returning_local_after_fallback_failure',
          query,
          topK,
          localCount: localResult.memories.length,
          mem0Mode: this.config.mem0Mode,
        }));
        return localResult;
      }
    }

    if (!hasMem0Auth(this.config)) {
      return { memories: [], source: 'none' };
    }

    try {
      return await this.searchMem0Enhanced(query, identity.userId, topK, filters, intent);
    } catch (err) {
      this.logStructuredException('memory_search.mem0_fallback_failed', {
        query,
        topK,
        localCount: 0,
        mem0Mode: this.config.mem0Mode,
        message: err instanceof Error ? err.message : String(err),
        cause: err instanceof Error && err.cause ? String(err.cause) : undefined,
      });
      return { memories: [], source: 'none' };
    }
  }

  private logStructuredException(event: string, fields: Record<string, unknown>): void {
    console.error(JSON.stringify({ event, fields }));
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
      const keys = buildMemoryDedupKeys({ text: memory.text, mem0: memory.mem0 });
      const dedupKeys = keys.length > 0 ? keys : [memory.memory_uid || `${memory.user_id}:${memory.text}`];
      if (dedupKeys.some((key) => seen.has(key))) {
        return false;
      }
      dedupKeys.forEach((key) => seen.add(key));
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
