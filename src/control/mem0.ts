import type { MemoryDomain, MemoryRecord, MemoryType, PluginConfig } from '../types';
import type { AutoCapturePayload } from '../capture/auto';
import { hasMem0Auth, buildMem0Headers } from './auth';
import { summarizeText, type PluginLogger } from '../debug/logger';

export type Mem0StoreResult =
  | { status: 'submitted'; mem0_id: string | null; event_id: string | null; hash: string | null; extractedMemories?: Mem0ExtractedMemory[] }
  | { status: 'unavailable' };

export type Mem0EventResult =
  | { status: 'confirmed' }
  | { status: 'timeout' }
  | { status: 'unavailable' };

export interface Mem0ExtractedMemory {
  id: string | null;
  text: string;
  categories: string[];
  memory_type?: MemoryType;
  domains?: MemoryDomain[];
  source_kind?: string;
  confidence?: number;
  hash: string | null;
}

function mapExtractedMemories(items: any[]): Mem0ExtractedMemory[] {
  return items
    .map((item: any) => ({
      id: item.id || null,
      text: item.memory || item.text || item.previous_memory || item.data?.memory || item.data?.text || item.data?.previous_memory || '',
      categories: Array.isArray(item.categories)
        ? item.categories
        : Array.isArray(item.data?.categories)
          ? item.data.categories
          : [],
      memory_type: item.metadata?.memory_type || item.data?.metadata?.memory_type || item.memory_type || undefined,
      domains: item.metadata?.domains || item.data?.metadata?.domains || item.domains || [],
      source_kind: item.metadata?.source_kind || item.data?.metadata?.source_kind || undefined,
      confidence: typeof item.metadata?.confidence === 'number' ? item.metadata.confidence : undefined,
      hash: item.hash || item.data?.hash || null,
    }))
    .filter((m: Mem0ExtractedMemory) => Boolean(m.text));
}

export interface Mem0Client {
  storeMemory(record: MemoryRecord): Promise<Mem0StoreResult>;
  captureTurn(payload: AutoCapturePayload): Promise<Mem0StoreResult>;
  waitForEvent(eventId: string, options?: { attempts?: number; delayMs?: number }): Promise<Mem0EventResult>;
  fetchCapturedMemories(params: { userId: string; eventId: string }): Promise<Mem0ExtractedMemory[]>;
  searchMemories(params: {
    query: string;
    userId: string;
    topK: number;
    filters?: Record<string, any>;
    rerank?: boolean;
  }): Promise<Mem0ExtractedMemory[]>;
}

export class HttpMem0Client implements Mem0Client {
  private readonly config: PluginConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly debug?: PluginLogger;

  constructor(config: PluginConfig, fetchImpl: typeof fetch = fetch, debug?: PluginLogger) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.debug = debug;
  }

  async storeMemory(record: MemoryRecord): Promise<Mem0StoreResult> {
    if (!hasMem0Auth(this.config)) {
      this.debug?.basic('mem0.store.unavailable', { reason: 'missing_auth', mode: this.config.mem0Mode });
      return { status: 'unavailable' };
    }

    let response;
    try {
      this.debug?.basic('mem0.store.request', {
        url: `${this.config.mem0BaseUrl}/v1/memories/`,
        mode: this.config.mem0Mode,
        userId: record.user_id,
      });
      this.debug?.verbose('mem0.store.payload', {
        ...summarizeText(record.text),
        categories: record.categories?.length || 0,
      });
      response = await this.fetchImpl(`${this.config.mem0BaseUrl}/v1/memories/`, {
        method: 'POST',
        headers: buildMem0Headers(this.config, { json: true }),
        body: JSON.stringify({
          messages: [{ role: 'user', content: record.text }],
          user_id: record.user_id,
          run_id: record.run_id || undefined,
          metadata: {
            memory_uid: record.memory_uid,
            scope: record.scope,
            categories: record.categories || [],
            memory_type: record.memory_type || 'generic',
            domains: record.domains || ['generic'],
            source_kind: record.source_kind || 'user_explicit',
            confidence: typeof record.confidence === 'number' ? record.confidence : 0.7,
            openclaw_refs: record.openclaw_refs || {},
            sensitivity: record.sensitivity || 'internal',
          },
        }),
      });
    } catch {
      this.debug?.error('mem0.store.error', { message: 'request_failed', mode: this.config.mem0Mode });
      return { status: 'unavailable' };
    }

    if (!response.ok) {
      throw new Error(`Mem0 sync failed: ${response.status}`);
    }

    const data: any = await response.json();
    this.debug?.basic('mem0.store.submitted', { status: response.status, eventId: data.event_id || data.id || null, mem0Id: data.id || data.mem0_id || null });
    return {
      status: 'submitted',
      mem0_id: data.id || data.mem0_id || null,
      event_id: data.event_id || data.id || null,
      hash: data.hash || null,
    };
  }

  async captureTurn(payload: AutoCapturePayload): Promise<Mem0StoreResult> {
    if (!hasMem0Auth(this.config)) {
      this.debug?.basic('mem0.capture.unavailable', { reason: 'missing_auth', mode: this.config.mem0Mode });
      return { status: 'unavailable' };
    }

    let response;
    try {
      this.debug?.basic('mem0.capture.request', {
        url: `${this.config.mem0BaseUrl}/v1/memories/`,
        mode: this.config.mem0Mode,
        userId: payload.userId,
      });
      this.debug?.verbose('mem0.capture.payload', {
        idempotencyKey: payload.idempotencyKey,
        messageCount: payload.messages.length,
        ...summarizeText(payload.messages.map((m) => m.content).join('\n')),
      });
      response = await this.fetchImpl(`${this.config.mem0BaseUrl}/v1/memories/`, {
        method: 'POST',
        headers: buildMem0Headers(this.config, { json: true }),
        body: JSON.stringify({
          messages: payload.messages,
          user_id: payload.userId,
          run_id: payload.runId || undefined,
          async_mode: false,
          metadata: {
            idempotency_key: payload.idempotencyKey,
            scope: payload.scope,
            source: 'auto-capture',
          },
        }),
      });
    } catch {
      this.debug?.error('mem0.capture.error', { message: 'request_failed', mode: this.config.mem0Mode });
      return { status: 'unavailable' };
    }

    if (!response.ok) {
      throw new Error(`Mem0 capture failed: ${response.status}`);
    }

    const data: any = await response.json();
    this.debug?.verbose('mem0.capture.response_raw', { isArray: Array.isArray(data), keys: Array.isArray(data) ? [] : Object.keys(data || {}) });

    // Mem0 may return extracted memories directly as an array (no event polling needed)
    if (Array.isArray(data)) {
      const extractedMemories = mapExtractedMemories(data);
      const queuedEventId = data.find((item: any) => typeof item?.event_id === 'string' && item.event_id)?.event_id || null;
      if (extractedMemories.length === 0 && queuedEventId) {
        this.debug?.basic('mem0.capture.submitted', { status: response.status, eventId: queuedEventId, mode: 'event_array' });
        return {
          status: 'submitted',
          mem0_id: null,
          event_id: queuedEventId,
          hash: null,
        };
      }
      this.debug?.basic('mem0.capture.submitted', { status: response.status, extractedCount: extractedMemories.length, mode: 'direct' });
      return { status: 'submitted', mem0_id: null, event_id: null, hash: null, extractedMemories };
    }

    if (Array.isArray(data?.results)) {
      const extractedMemories = mapExtractedMemories(data.results);
      if (extractedMemories.length > 0) {
        this.debug?.basic('mem0.capture.submitted', { status: response.status, extractedCount: extractedMemories.length, mode: 'direct_object' });
        return { status: 'submitted', mem0_id: null, event_id: null, hash: null, extractedMemories };
      }
    }

    const event_id = data.event_id || null;
    this.debug?.basic('mem0.capture.submitted', { status: response.status, eventId: event_id, mem0Id: data.id || data.mem0_id || null, mode: 'event' });
    return {
      status: 'submitted',
      mem0_id: data.id || data.mem0_id || null,
      event_id,
      hash: data.hash || null,
    };
  }

  async waitForEvent(eventId: string, options?: { attempts?: number; delayMs?: number }): Promise<Mem0EventResult> {
    if (!hasMem0Auth(this.config)) {
      this.debug?.basic('mem0.event.unavailable', { reason: 'missing_auth', mode: this.config.mem0Mode, eventId });
      return { status: 'unavailable' };
    }

    const attempts = options?.attempts ?? 3;
    const delayMs = options?.delayMs ?? 25;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response;
      try {
        this.debug?.verbose('mem0.event.poll', { eventId, attempt: attempt + 1, attempts });
        response = await this.fetchImpl(`${this.config.mem0BaseUrl}/v1/event/${eventId}/`, {
          method: 'GET',
          headers: buildMem0Headers(this.config),
        });
      } catch {
        this.debug?.error('mem0.event.error', { eventId, attempt: attempt + 1, message: 'request_failed' });
        return { status: 'unavailable' };
      }

      if (!response.ok) {
        throw new Error(`Mem0 event confirm failed: ${response.status}`);
      }

      const data: any = await response.json();
      if (String(data.status || '').toLowerCase() === 'completed') {
        this.debug?.basic('mem0.event.confirmed', { eventId, attempt: attempt + 1 });
        return { status: 'confirmed' };
      }

      if (delayMs > 0 && attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    this.debug?.basic('mem0.event.timeout', { eventId, attempts });
    return { status: 'timeout' };
  }

  async fetchCapturedMemories(params: { userId: string; eventId: string }): Promise<Mem0ExtractedMemory[]> {
    if (!hasMem0Auth(this.config)) {
      this.debug?.basic('mem0.fetch_captured.unavailable', { reason: 'missing_auth', mode: this.config.mem0Mode, eventId: params.eventId });
      return [];
    }

    const query = new URLSearchParams({
      user_id: params.userId,
      event_id: params.eventId,
    });
    
    let response;
    try {
      this.debug?.basic('mem0.fetch_captured.request', { eventId: params.eventId, userId: params.userId });
      response = await this.fetchImpl(`${this.config.mem0BaseUrl}/v1/memories/?${query.toString()}`, {
        method: 'GET',
        headers: buildMem0Headers(this.config),
      });
    } catch {
      this.debug?.error('mem0.fetch_captured.error', { eventId: params.eventId, message: 'request_failed' });
      return [];
    }

    if (!response.ok) {
      throw new Error(`Mem0 fetch captured memories failed: ${response.status}`);
    }

    const data: any = await response.json();
    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    const memories = items
      .map((item: any) => ({
        id: item.id || item.mem0_id || null,
        text: item.memory || item.text || '',
        categories: Array.isArray(item.categories) ? item.categories : [],
        memory_type: item.metadata?.memory_type || item.memory_type || undefined,
        domains: item.metadata?.domains || item.domains || [],
        source_kind: item.metadata?.source_kind || undefined,
        confidence: typeof item.metadata?.confidence === 'number' ? item.metadata.confidence : undefined,
        hash: item.hash || null,
      }))
      .filter((item: Mem0ExtractedMemory) => Boolean(item.text));
    this.debug?.basic('mem0.fetch_captured.result', { eventId: params.eventId, count: memories.length });
    memories.forEach((memory: Mem0ExtractedMemory) => {
      this.debug?.verbose('mem0.fetch_captured.memory', {
        eventId: params.eventId,
        id: memory.id,
        ...summarizeText(memory.text),
      });
    });
    return memories;
  }

  async searchMemories(params: {
    query: string;
    userId: string;
    topK: number;
    filters?: Record<string, any>;
    rerank?: boolean;
  }): Promise<Mem0ExtractedMemory[]> {
    if (!hasMem0Auth(this.config)) {
      this.debug?.basic('mem0.search.unavailable', { reason: 'missing_auth', mode: this.config.mem0Mode });
      return [];
    }

    let response;
    try {
      this.debug?.basic('mem0.search.request', {
        query: params.query,
        userId: params.userId,
        topK: params.topK,
        rerank: params.rerank ?? false,
      });
      const requestFilters =
        this.config.mem0Mode === 'local'
          ? normalizeLocalMem0Filters(params.filters || {})
          : (params.filters || {});
      response = await this.fetchImpl(`${this.config.mem0BaseUrl}/v1/memories/search/`, {
        method: 'POST',
        headers: buildMem0Headers(this.config, { json: true }),
        body: JSON.stringify({
          query: params.query,
          user_id: params.userId,
          top_k: params.topK,
          filters: requestFilters,
          rerank: params.rerank ?? false,
          include_vectors: false,
        }),
      });
    } catch {
      this.debug?.error('mem0.search.error', { message: 'request_failed' });
      return [];
    }

    if (!response.ok) {
      throw new Error(`Mem0 search failed: ${response.status}`);
    }

    const data: any = await response.json();
    const items = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : Array.isArray(data?.items) ? data.items : [];
    const memories = items
      .map((item: any) => ({
        id: item.id || item.mem0_id || null,
        text: item.memory || item.text || '',
        categories: Array.isArray(item.categories) ? item.categories : item.metadata?.categories || [],
        memory_type: item.metadata?.memory_type || item.memory_type || undefined,
        domains: item.metadata?.domains || item.domains || [],
        source_kind: item.metadata?.source_kind || undefined,
        confidence: typeof item.metadata?.confidence === 'number' ? item.metadata.confidence : undefined,
        hash: item.hash || null,
      }))
      .filter((item: Mem0ExtractedMemory) => Boolean(item.text));
    this.debug?.basic('mem0.search.result', { count: memories.length, rerank: params.rerank ?? false });
    return memories;
  }
}

export class FakeMem0Client implements Mem0Client {
  private readonly storeResult: Mem0StoreResult;
  private readonly eventResult: Mem0EventResult;

  constructor(
    storeResult: Mem0StoreResult = { status: 'unavailable' },
    eventResult: Mem0EventResult = { status: 'unavailable' },
  ) {
    this.storeResult = storeResult;
    this.eventResult = eventResult;
  }

  async storeMemory(_record: MemoryRecord): Promise<Mem0StoreResult> {
    return this.storeResult;
  }

  async captureTurn(_payload: AutoCapturePayload): Promise<Mem0StoreResult> {
    return this.storeResult;
  }

  async waitForEvent(_eventId: string, _options?: { attempts?: number; delayMs?: number }): Promise<Mem0EventResult> {
    return this.eventResult;
  }

  async fetchCapturedMemories(_params: { userId: string; eventId: string }): Promise<Mem0ExtractedMemory[]> {
    return [];
  }

  async searchMemories(_params: {
    query: string;
    userId: string;
    topK: number;
    filters?: Record<string, any>;
    rerank?: boolean;
  }): Promise<Mem0ExtractedMemory[]> {
    return [];
  }
}

function normalizeLocalMem0Filters(filters: Record<string, any>): Record<string, string | number | boolean> {
  const normalized: Record<string, string | number | boolean> = {};
  collectLocalMem0FilterLeaves(filters, normalized);
  return normalized;
}

function collectLocalMem0FilterLeaves(
  value: unknown,
  target: Record<string, string | number | boolean>,
  prefix?: string,
): void {
  if (value === null || value === undefined) {
    return;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (prefix) {
      target[prefix] = value;
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectLocalMem0FilterLeaves(item, target, prefix);
    }
    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'AND' || key === 'OR' || key === 'NOT' || key === 'in') {
      collectLocalMem0FilterLeaves(child, target, prefix);
      continue;
    }

    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    collectLocalMem0FilterLeaves(child, target, nextPrefix);
  }
}
