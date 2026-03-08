import { LanceDbMemoryAdapter } from './adapter';
import { hasMem0Auth, buildMem0Headers } from '../control/auth';
import type { PluginDebugLogger } from '../debug/logger';
import type { PluginConfig } from '../types';

export class Mem0Poller {
  private timer: NodeJS.Timeout | null = null;
  private readonly config: PluginConfig;
  private readonly debug?: PluginDebugLogger;
  private lastSyncTime: string;

  constructor(config: PluginConfig, debug?: PluginDebugLogger) {
    this.config = config;
    this.debug = debug;
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
      this.debug?.basic('mem0_poller.skipped', { reason: 'mem0_unavailable' });
      return;
    }

    try {
      this.debug?.basic('mem0_poller.start', { baseUrl: this.config.mem0BaseUrl, mode: this.config.mem0Mode });
      const url = new URL(`${this.config.mem0BaseUrl}/v1/memories/`);
      url.searchParams.set('user_id', 'default');
      
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: buildMem0Headers(this.config),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch from Mem0: ${response.status}`);
      }

      const data: any = await response.json();
      const memories = Array.isArray(data) ? data : Array.isArray(data.results) ? data.results : Array.isArray(data.items) ? data.items : [];
      this.debug?.basic('mem0_poller.fetched', { count: memories.length });
      
      const adapter = new LanceDbMemoryAdapter(this.config.lancedbPath, this.config.embedding);
      let synced = 0;

      for (const mem of memories) {
        const memoryUid = mem.metadata?.memory_uid || mem.id;
        if (!memoryUid) continue;

        if (mem.updated_at && new Date(mem.updated_at) <= new Date(this.lastSyncTime)) {
          continue;
        }

        const isDeleted = mem.is_deleted || mem.status === 'deleted';

        await adapter.upsertMemory({
          memory_uid: memoryUid,
          memory: {
            user_id: mem.user_id || 'default',
            run_id: mem.run_id || '',
            scope: mem.metadata?.scope || 'long-term',
            text: mem.memory || mem.text || '',
            categories: mem.categories || mem.metadata?.categories || [],
            tags: mem.tags || [],
            ts_event: mem.created_at || new Date().toISOString(),
            source: 'openclaw',
            status: isDeleted ? 'deleted' : (mem.status || 'active'),
            sensitivity: mem.metadata?.sensitivity || 'internal',
            openclaw_refs: mem.metadata?.openclaw_refs || {},
            mem0: {
              mem0_id: mem.id || null,
              event_id: mem.event_id || null,
              hash: mem.hash || null,
            },
          }
        });
        synced += 1;
        this.debug?.verbose('mem0_poller.synced_memory', { memoryUid });
      }
      this.lastSyncTime = new Date().toISOString();
      this.debug?.basic('mem0_poller.done', { fetched: memories.length, synced });
    } catch (err) {
      this.debug?.error('mem0_poller.error', { message: err instanceof Error ? err.message : String(err) });
      console.error('[Mem0Poller] Poll failed:', err);
    }
  }
}
