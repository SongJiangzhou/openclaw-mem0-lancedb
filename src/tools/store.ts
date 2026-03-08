import * as crypto from 'node:crypto';

import { FileAuditStore } from '../audit/store';
import { LanceDbMemoryAdapter } from '../bridge/adapter';
import { FileOutbox } from '../bridge/outbox';
import { MemorySyncEngine } from '../bridge/sync-engine';
import { HttpMem0Client } from '../control/mem0';
import { sanitizeMemoryText } from '../capture/security';
import { PluginDebugLogger, summarizeText } from '../debug/logger';
import { inferMemoryAnnotations } from '../memory/typing';
import type { MemorySyncPayload, PluginConfig, StoreParams, StoreResult } from '../types';

export class MemoryStoreTool {
  private config: PluginConfig;
  private readonly debug: PluginDebugLogger;

  constructor(config: PluginConfig, debug?: PluginDebugLogger) {
    this.config = config;
    this.debug = debug || new PluginDebugLogger(config.debug);
  }

  async execute(params: StoreParams): Promise<StoreResult> {
    const { text, userId, scope = 'long-term', metadata = {}, categories = [] } = params;

    try {
      this.debug.basic('memory_store.start', {
        userId,
        scope,
        categories: categories.length,
        ...summarizeText(text),
      });
      const eventId = `local-${crypto.randomUUID()}`;
      const outbox = new FileOutbox(this.config.outboxDbPath);
      const auditStore = new FileAuditStore(this.config.auditStorePath);
      const adapter = new LanceDbMemoryAdapter(this.config.lancedbPath, this.config.embedding);
      const mem0Client = new HttpMem0Client(this.config, fetch, this.debug);
      const engine = new MemorySyncEngine(outbox, auditStore, adapter, mem0Client);
      const payload = this.buildPayload({
        text,
        userId,
        scope,
        metadata,
        categories,
        memoryType: params.memoryType,
        domains: params.domains,
        sourceKind: params.sourceKind,
        confidence: params.confidence,
        eventId,
      });
      const result = await engine.processEvent(eventId, payload);

      if (result.status === 'synced' || result.status === 'partial' || result.status === 'accepted' || result.status === 'duplicate') {
        this.debug.basic('memory_store.done', { success: true, memoryUid: result.memory_uid, eventId, syncStatus: result.status });
        return { success: true, memoryUid: result.memory_uid, eventId, syncStatus: result.status };
      }

      this.debug.basic('memory_store.done', { success: false, memoryUid: result.memory_uid, eventId, syncStatus: result.status });
      return { success: false, memoryUid: result.memory_uid, eventId, syncStatus: result.status, error: result.status };
    } catch (err: any) {
      this.debug.error('memory_store.error', { message: err.message || 'Unknown error' });
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
    memoryType?: StoreParams['memoryType'];
    domains?: StoreParams['domains'];
    sourceKind?: StoreParams['sourceKind'];
    confidence?: StoreParams['confidence'];
    eventId: string;
  }): MemorySyncPayload {
    const { cleanText, isRestricted } = sanitizeMemoryText(params.text);
    const annotations = inferMemoryAnnotations({
      text: cleanText,
      categories: params.categories,
      sourceKind: params.metadata.source_kind || params.metadata.sourceKind || params.sourceKind,
      confidence: params.metadata.confidence || params.confidence,
    });
    return {
      user_id: params.userId,
      run_id: params.metadata.run_id || '',
      scope: params.scope,
      text: cleanText,
      categories: params.categories,
      tags: Array.isArray(params.metadata.tags) ? params.metadata.tags : [],
      memory_type: params.memoryType || annotations.memoryType,
      domains: params.domains || annotations.domains,
      source_kind: params.sourceKind || annotations.sourceKind,
      confidence: typeof params.confidence === 'number' ? params.confidence : annotations.confidence,
      ts_event: new Date().toISOString(),
      source: 'openclaw',
      status: 'active',
      sensitivity: isRestricted ? 'restricted' : (params.metadata.sensitivity || 'internal'),
      openclaw_refs: params.metadata.openclaw_refs || {},
      mem0: {
        event_id: null,
        hash: params.metadata.mem0_hash || null,
        mem0_id: params.metadata.mem0_id || null,
      },
    };
  }
}
