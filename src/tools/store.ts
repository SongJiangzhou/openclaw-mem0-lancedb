import { PluginConfig, StoreParams, StoreResult } from '../types';
import * as crypto from 'crypto';
import { openMemoryTable } from '../db/table';

export class MemoryStoreTool {
  private config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  async execute(params: StoreParams): Promise<StoreResult> {
    const { text, userId, scope = 'long-term', metadata = {}, categories = [] } = params;

    try {
      const tsBucket = new Date().toISOString().slice(0, 13);
      const memoryUid = this.buildMemoryUid(userId, scope, text, tsBucket, categories[0] || 'general');

      // No Mem0 key → 直接写 LanceDB
      if (!this.config.mem0ApiKey) {
        await this.storeToLanceDB({
          memory_uid: memoryUid,
          user_id: userId,
          run_id: '',
          scope,
          text,
          categories: JSON.stringify(categories),
          tags: JSON.stringify((metadata as any).tags || []),
          ts_event: new Date().toISOString(),
          source: 'openclaw',
          status: 'active',
          sensitivity: (metadata as any).sensitivity || 'internal',
          openclaw_refs: JSON.stringify((metadata as any).openclaw_refs || {}),
          mem0_event_id: `local-${Date.now()}`,
          mem0_hash: '',
        });
        return { success: true, memoryUid, eventId: `local-${Date.now()}` };
      }

      // 有 Mem0 Key → 走 Mem0 云端
      const mem0Result = await this.storeToMem0({ memoryUid, text, userId, scope, metadata, categories });
      await this.storeToLanceDB({
        memory_uid: memoryUid,
        user_id: userId,
        run_id: '',
        scope,
        text,
        categories: JSON.stringify(categories),
        tags: JSON.stringify([]),
        ts_event: new Date().toISOString(),
        source: 'openclaw',
        status: 'active',
        sensitivity: 'internal',
        openclaw_refs: '{}',
        mem0_event_id: mem0Result.eventId,
        mem0_hash: '',
      });
      return { success: true, memoryUid, eventId: mem0Result.eventId };

    } catch (err: any) {
      console.error('[memoryStore] Failed:', err);
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  private buildMemoryUid(userId: string, scope: string, text: string, tsBucket: string, category: string): string {
    const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
    const raw = [userId.trim(), scope.trim(), normalized, tsBucket.trim(), category.trim()].join('|');
    return crypto.createHash('sha256').update(raw, 'utf-8').digest('hex');
  }

  private async storeToLanceDB(row: Record<string, string>): Promise<void> {
    const tbl = await openMemoryTable(this.config.lancedbPath);
    // 幂等：先查是否已存在
    const existing = await tbl.query().where(`memory_uid = '${row.memory_uid}'`).limit(1).toArray();
    if (existing.length > 0) return;
    await tbl.add([row]);
  }

  private async storeToMem0(params: {
    memoryUid: string; text: string; userId: string; scope: string;
    metadata: Record<string, any>; categories: string[];
  }): Promise<{ eventId: string }> {
    const url = `${this.config.mem0BaseUrl}/v1/memories/`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${this.config.mem0ApiKey}` },
      body: JSON.stringify({
        messages: [{ role: 'user', content: params.text }],
        user_id: params.userId,
        metadata: { ...params.metadata, memory_uid: params.memoryUid, scope: params.scope, categories: params.categories }
      })
    });
    if (!response.ok) throw new Error(`Mem0 store failed: ${response.status}`);
    const data: any = await response.json();
    return { eventId: data.id || data.event_id || 'unknown' };
  }
}
