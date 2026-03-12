import { FileAuditStore } from '../audit/store';
import type { MemoryAdapter } from '../bridge/adapter';
import { backfillLifecycleFields, reinforceLifecycle } from '../memory/lifecycle';
import { recordToPayload } from '../memory/mapper';
import type { SearchResult } from '../types';

export async function reinforceRecalledMemories(params: {
  auditStore: FileAuditStore;
  adapter: MemoryAdapter;
  memories: SearchResult['memories'];
  nowIso?: string;
}): Promise<number> {
  const latestRows = await params.auditStore.readLatestRows();
  const latestByUid = new Map(latestRows.map((row) => [row.memory_uid, backfillLifecycleFields(row)]));
  const nowIso = params.nowIso || new Date().toISOString();
  let updatedCount = 0;

  for (const memory of params.memories) {
    const current = latestByUid.get(memory.memory_uid);
    if (!current) {
      continue;
    }
    const updated = reinforceLifecycle(current, nowIso);
    await params.auditStore.append(updated);
    await params.adapter.updateMemoryMetadata({
      memory_uid: updated.memory_uid,
      memory: recordToPayload(updated),
    });
    updatedCount += 1;
  }

  return updatedCount;
}
