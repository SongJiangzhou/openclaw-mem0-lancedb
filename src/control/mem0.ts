import type { MemoryRecord, PluginConfig } from '../types';
import type { AutoCapturePayload } from '../capture/auto';

export type Mem0StoreResult =
  | { status: 'submitted'; mem0_id: string | null; event_id: string | null; hash: string | null }
  | { status: 'unavailable' };

export type Mem0EventResult =
  | { status: 'confirmed' }
  | { status: 'timeout' }
  | { status: 'unavailable' };

export interface Mem0Client {
  storeMemory(record: MemoryRecord): Promise<Mem0StoreResult>;
  captureTurn(payload: AutoCapturePayload): Promise<Mem0StoreResult>;
  waitForEvent(eventId: string, options?: { attempts?: number; delayMs?: number }): Promise<Mem0EventResult>;
}

export class HttpMem0Client implements Mem0Client {
  private readonly config: PluginConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: PluginConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async storeMemory(record: MemoryRecord): Promise<Mem0StoreResult> {
    if (!this.config.mem0ApiKey) {
      return { status: 'unavailable' };
    }

    const response = await this.fetchImpl(`${this.config.mem0BaseUrl}/v1/memories/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${this.config.mem0ApiKey}`,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: record.text }],
        user_id: record.user_id,
        run_id: record.run_id || undefined,
        metadata: {
          memory_uid: record.memory_uid,
          scope: record.scope,
          categories: record.categories || [],
          openclaw_refs: record.openclaw_refs || {},
          sensitivity: record.sensitivity || 'internal',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Mem0 sync failed: ${response.status}`);
    }

    const data: any = await response.json();
    return {
      status: 'submitted',
      mem0_id: data.id || data.mem0_id || null,
      event_id: data.event_id || data.id || null,
      hash: data.hash || null,
    };
  }

  async captureTurn(payload: AutoCapturePayload): Promise<Mem0StoreResult> {
    if (!this.config.mem0ApiKey) {
      return { status: 'unavailable' };
    }

    const response = await this.fetchImpl(`${this.config.mem0BaseUrl}/v1/memories/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Token ${this.config.mem0ApiKey}`,
      },
      body: JSON.stringify({
        messages: payload.messages,
        user_id: payload.userId,
        run_id: payload.runId || undefined,
        metadata: {
          idempotency_key: payload.idempotencyKey,
          scope: payload.scope,
          source: 'auto-capture',
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Mem0 capture failed: ${response.status}`);
    }

    const data: any = await response.json();
    return {
      status: 'submitted',
      mem0_id: data.id || data.mem0_id || null,
      event_id: data.event_id || data.id || null,
      hash: data.hash || null,
    };
  }

  async waitForEvent(eventId: string, options?: { attempts?: number; delayMs?: number }): Promise<Mem0EventResult> {
    if (!this.config.mem0ApiKey) {
      return { status: 'unavailable' };
    }

    const attempts = options?.attempts ?? 3;
    const delayMs = options?.delayMs ?? 25;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await this.fetchImpl(`${this.config.mem0BaseUrl}/v1/events/${eventId}`, {
        method: 'GET',
        headers: {
          Authorization: `Token ${this.config.mem0ApiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Mem0 event confirm failed: ${response.status}`);
      }

      const data: any = await response.json();
      if (String(data.status || '').toLowerCase() === 'completed') {
        return { status: 'confirmed' };
      }

      if (delayMs > 0 && attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return { status: 'timeout' };
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
}
