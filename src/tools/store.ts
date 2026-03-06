import * as crypto from 'node:crypto';

import { FileAuditStore } from '../audit/store';
import { LanceDbMemoryAdapter } from '../bridge/adapter';
import { FileOutbox } from '../bridge/outbox';
import { MemorySyncEngine } from '../bridge/sync-engine';
import { HttpMem0Client } from '../control/mem0';
import type { MemorySyncPayload, PluginConfig, StoreParams, StoreResult } from '../types';

export class MemoryStoreTool {
  private config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  async execute(params: StoreParams): Promise<StoreResult> {
    const { text, userId, scope = 'long-term', metadata = {}, categories = [] } = params;

    try {
      const eventId = `local-${crypto.randomUUID()}`;
      const outbox = new FileOutbox(this.config.outboxDbPath);
      const auditStore = new FileAuditStore(this.config.auditStorePath);
      const adapter = new LanceDbMemoryAdapter(this.config.lancedbPath);
      const mem0Client = new HttpMem0Client(this.config);
      const engine = new MemorySyncEngine(outbox, auditStore, adapter, mem0Client);
      const payload = this.buildPayload({
        text,
        userId,
        scope,
        metadata,
        categories,
        eventId,
      });
      const result = await engine.processEvent(eventId, payload);

      if (result.status === 'synced' || result.status === 'partial' || result.status === 'accepted' || result.status === 'duplicate') {
        return { success: true, memoryUid: result.memory_uid, eventId, syncStatus: result.status };
      }

      return { success: false, memoryUid: result.memory_uid, eventId, syncStatus: result.status, error: result.status };
    } catch (err: any) {
      console.error('[memoryStore] Failed:', err);
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  private buildPayload(params: {
    text: string;
    userId: string;
    scope: 'long-term' | 'session';
    metadata: Record<string, any>;
    categories: string[];
    eventId: string;
  }): MemorySyncPayload {
    return {
      user_id: params.userId,
      run_id: params.metadata.run_id || '',
      scope: params.scope,
      text: params.text,
      categories: params.categories,
      tags: Array.isArray(params.metadata.tags) ? params.metadata.tags : [],
      ts_event: new Date().toISOString(),
      source: 'openclaw',
      status: 'active',
      sensitivity: params.metadata.sensitivity || 'internal',
      openclaw_refs: params.metadata.openclaw_refs || {},
      mem0: {
        event_id: null,
        hash: params.metadata.mem0_hash || null,
        mem0_id: params.metadata.mem0_id || null,
      },
    };
  }
}
