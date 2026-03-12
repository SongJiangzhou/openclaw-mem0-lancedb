import type { MemoryAdapter } from '../bridge/adapter';
import { backfillLifecycleFields, reinforceLifecycle } from '../memory/lifecycle';
import { recordToPayload } from '../memory/mapper';
import type { SearchResult } from '../types';

export async function reinforceRecalledMemories(params: {
  adapter: MemoryAdapter;
  memories: SearchResult['memories'];
  nowIso?: string;
}): Promise<number> {
  const nowIso = params.nowIso || new Date().toISOString();
  let updatedCount = 0;

  for (const memory of params.memories) {
    const currentPayload = await params.adapter.getMemory(memory.memory_uid);
    const current = currentPayload
      ? backfillLifecycleFields({
        ...memory,
        ...currentPayload,
        memory_uid: memory.memory_uid,
      })
      : null;
    if (!current) {
      continue;
    }
    const updated = reinforceLifecycle(current, nowIso);
    await params.adapter.updateMemoryMetadata({
      memory_uid: updated.memory_uid,
      memory: recordToPayload(updated),
    });
    updatedCount += 1;
  }

  return updatedCount;
}
