import type { MemoryRecord, PluginConfig } from '../types';

export type Mem0SyncResult =
  | { status: 'synced'; mem0_id: string | null; event_id: string | null; hash: string | null }
  | { status: 'unavailable' };

export interface Mem0Client {
  syncMemory(record: MemoryRecord): Promise<Mem0SyncResult>;
}

export class HttpMem0Client implements Mem0Client {
  private readonly config: PluginConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: PluginConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async syncMemory(record: MemoryRecord): Promise<Mem0SyncResult> {
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
      status: 'synced',
      mem0_id: data.id || data.mem0_id || null,
      event_id: data.event_id || data.id || null,
      hash: data.hash || null,
    };
  }
}

export class FakeMem0Client implements Mem0Client {
  private readonly result: Mem0SyncResult;

  constructor(result: Mem0SyncResult) {
    this.result = result;
  }

  async syncMemory(_record: MemoryRecord): Promise<Mem0SyncResult> {
    return this.result;
  }
}
