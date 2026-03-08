import type { AutoRecallConfig, SearchResult } from '../types';
import { summarizeText, type PluginDebugLogger } from '../debug/logger';

export function buildAutoRecallBlock(memories: SearchResult['memories'], config: AutoRecallConfig, source?: string): string {
  if (!memories.length) {
    return '';
  }

  const lines = memories
    .slice(0, config.topK)
    .map((memory) => `- [${memory.scope}] ${memory.text}`);
  const sourceAttr = source ? ` source="${source}"` : '';
  let block = `<relevant_memories${sourceAttr}>\n${lines.join('\n')}\n</relevant_memories>`;
  if (block.length > config.maxChars) {
    block = `${block.slice(0, Math.max(0, config.maxChars - 3))}...`;
  }
  return block;
}

export async function runAutoRecall(params: {
  query: string;
  userId: string;
  config: AutoRecallConfig;
  debug?: PluginDebugLogger;
  search: (input: { query: string; userId: string; topK: number; filters?: { scope?: string } }) => Promise<SearchResult>;
}): Promise<{ block: string; source: string }> {
  if (!params.config.enabled) {
    params.debug?.basic('auto_recall.skipped', { reason: 'disabled' });
    return { block: '', source: 'none' };
  }

  params.debug?.basic('auto_recall.start', {
    userId: params.userId,
    topK: params.config.topK,
    scope: params.config.scope,
    ...summarizeText(params.query),
  });

  const result = await params.search({
    query: params.query,
    userId: params.userId,
    topK: params.config.topK,
    filters: params.config.scope === 'long-term' ? { scope: 'long-term' } : undefined,
  });

  if (!result.memories.length) {
    params.debug?.basic('auto_recall.empty', { source: result.source });
    return { block: '', source: result.source };
  }

  const block = buildAutoRecallBlock(result.memories, params.config, result.source);
  params.debug?.basic('auto_recall.done', {
    source: result.source,
    hits: result.memories.length,
    injectedChars: block.length,
  });
  result.memories.forEach((memory) => {
    params.debug?.verbose('auto_recall.memory', {
      memoryUid: memory.memory_uid,
      scope: memory.scope,
      ...summarizeText(memory.text),
    });
  });
  return { block, source: result.source };
}
