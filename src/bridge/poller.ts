import { LanceDbMemoryAdapter, type MemoryAdapter } from './adapter';
import { hasMem0Auth, buildMem0Headers } from '../control/auth';
import { PluginDebugLogger, type PluginLogger } from '../debug/logger';
import { backfillLifecycleFields } from '../memory/lifecycle';
import { inferMemoryAnnotations } from '../memory/typing';
import { resolveSharedUserId } from '../memory/user-space';
import type { PluginConfig } from '../types';

export class Mem0Poller {
  private timer: NodeJS.Timeout | null = null;
  private readonly config: PluginConfig;
  private readonly debug: PluginLogger;
  private readonly adapter?: MemoryAdapter;
  private lastSyncTime: string;

  constructor(config: PluginConfig, debug?: PluginLogger, adapter?: MemoryAdapter) {
    this.config = config;
    this.debug = debug || new PluginDebugLogger(config.debug).child('memory.poller');
    this.adapter = adapter;
    this.lastSyncTime = new Date().toISOString();
  }

  start(intervalMs: number = 5 * 60 * 1000) {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => this.poll(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async poll() {
    if (!hasMem0Auth(this.config) || !this.config.mem0BaseUrl) {
      this.debug.basic('mem0_poller.skipped', { reason: 'mem0_unavailable' });
      return;
    }

    try {
      this.debug.basic('mem0_poller.start', { baseUrl: this.config.mem0BaseUrl, mode: this.config.mem0Mode });
      const url = new URL(`${this.config.mem0BaseUrl}/v1/memories/`);
      url.searchParams.set('user_id', resolveSharedUserId());

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: buildMem0Headers(this.config),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch from Mem0: ${response.status}`);
      }

      const data: any = await response.json();
      const memories = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : Array.isArray(data.items) ? data.items : [];
      this.debug.basic('mem0_poller.fetched', { count: memories.length });

      const adapter = this.adapter || new LanceDbMemoryAdapter(this.config.lancedbPath, this.config.embedding);
      let synced = 0;

      for (const mem of memories) {
        const memoryUid = mem.metadata?.memory_uid || mem.id;
        if (!memoryUid) continue;

        if (mem.updated_at && new Date(mem.updated_at) <= new Date(this.lastSyncTime)) {
          continue;
        }

        const isDeleted = mem.is_deleted || mem.status === 'deleted';
        const annotations = inferMemoryAnnotations({
          text: mem.memory || mem.text || '',
          categories: mem.categories || mem.metadata?.categories || [],
          sourceKind: mem.metadata?.source_kind || mem.metadata?.sourceKind,
          confidence: mem.metadata?.confidence,
        });
        const payload = backfillLifecycleFields({
          user_id: resolveSharedUserId(mem.user_id),
          session_id: String(mem.metadata?.session_id || ''),
          agent_id: String(mem.metadata?.agent_id || ''),
          run_id: mem.run_id || '',
          scope: mem.metadata?.scope || 'long-term',
          text: mem.memory || mem.text || '',
          categories: mem.categories || mem.metadata?.categories || [],
          tags: mem.tags || [],
          memory_type: mem.metadata?.memory_type || mem.metadata?.memoryType || annotations.memoryType,
          domains: mem.metadata?.domains || annotations.domains,
          source_kind: mem.metadata?.source_kind || mem.metadata?.sourceKind || annotations.sourceKind,
          confidence: typeof mem.metadata?.confidence === 'number' ? mem.metadata.confidence : annotations.confidence,
          ts_event: mem.created_at || new Date().toISOString(),
          source: 'openclaw' as const,
          status: isDeleted ? 'deleted' : (mem.status || 'active'),
          sensitivity: mem.metadata?.sensitivity || 'internal',
          openclaw_refs: mem.metadata?.openclaw_refs || {},
          mem0: {
            mem0_id: mem.id || null,
            event_id: mem.event_id || null,
            hash: mem.hash || null,
          },
        });
        const duplicateMemoryUid = await adapter.findDuplicateMemoryUid(payload);
        const targetMemoryUid = duplicateMemoryUid || memoryUid;

        await adapter.upsertMemory({
          memory_uid: targetMemoryUid,
          memory: payload,
        });
        synced += 1;
        this.debug.verbose('mem0_poller.synced_memory', { memoryUid: targetMemoryUid });
      }
      this.lastSyncTime = new Date().toISOString();
      this.debug.basic('mem0_poller.done', { fetched: memories.length, synced });
    } catch (err) {
      this.debug.exception('mem0_poller.error', err, {
        baseUrl: this.config.mem0BaseUrl,
        mode: this.config.mem0Mode,
      });
    }
  }
}
