import type { AutoRecallConfig, SearchResult } from '../types';

export function buildAutoRecallBlock(memories: SearchResult['memories'], config: AutoRecallConfig): string {
  if (!memories.length) {
    return '';
  }

  const lines = memories
    .slice(0, config.topK)
    .map((memory) => `- [${memory.scope}] ${memory.text}`);
  let block = `<relevant_memories>\n${lines.join('\n')}\n</relevant_memories>`;
  if (block.length > config.maxChars) {
    block = `${block.slice(0, Math.max(0, config.maxChars - 3))}...`;
  }
  return block;
}

export async function runAutoRecall(params: {
  query: string;
  userId: string;
  config: AutoRecallConfig;
  search: (input: { query: string; userId: string; topK: number; filters?: { scope?: string } }) => Promise<SearchResult>;
}): Promise<string> {
  if (!params.config.enabled) {
    return '';
  }

  const result = await params.search({
    query: params.query,
    userId: params.userId,
    topK: params.config.topK,
    filters: params.config.scope === 'long-term' ? { scope: 'long-term' } : undefined,
  });

  if (!result.memories.length) {
    return '';
  }

  return buildAutoRecallBlock(result.memories, params.config);
}
