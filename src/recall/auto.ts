import type { AutoRecallConfig, SearchResult } from '../types';
import { summarizeText, type PluginDebugLogger } from '../debug/logger';
import { buildRecallQueryVariants } from './query-rewrite';
import { createLocalRecallReranker, type RecallReranker } from './reranker';
import { deriveRecallSizing } from './sizing';

export function buildAutoRecallBlock(memories: SearchResult['memories'], config: AutoRecallConfig, source?: string): string {
  if (!memories.length) {
    return '';
  }

  const sourceAttr = source ? ` source="${source}"` : '';
  const header = `<recall${sourceAttr}>\n`;
  const footer = `\n</recall>`;
  const maxChars = Math.max(0, config.maxChars);
  const budget = Math.max(0, maxChars - header.length - footer.length);
  const lines: string[] = [];

  for (const memory of memories.slice(0, config.topK)) {
    const candidateLine = `- [${memory.scope}] ${memory.text}`;
    const separator = lines.length > 0 ? 1 : 0;
    const nextLength = lines.join('\n').length + separator + candidateLine.length;

    if (nextLength <= budget) {
      lines.push(candidateLine);
      continue;
    }

    if (lines.length > 0) {
      break;
    }

    const truncated = truncateRecallLine(candidateLine, budget);
    if (truncated) {
      lines.push(truncated);
    }
    break;
  }

  if (lines.length === 0) {
    return `${header.trimEnd()}</recall>`;
  }

  return `${header}${lines.join('\n')}${footer}`;
}

function truncateRecallLine(line: string, budget: number): string {
  if (budget <= 0) {
    return '';
  }
  if (line.length <= budget) {
    return line;
  }
  if (budget <= 3) {
    return '.'.repeat(budget);
  }
  return `${line.slice(0, budget - 3)}...`;
}

export async function runAutoRecall(params: {
  query: string;
  userId: string;
  sessionId?: string;
  agentId?: string;
  config: AutoRecallConfig;
  debug?: PluginDebugLogger;
  reranker?: RecallReranker;
  search: (input: { query: string; userId: string; sessionId?: string; agentId?: string; topK: number; filters?: { scope?: string } }) => Promise<SearchResult>;
}): Promise<{ block: string; source: string; memories: SearchResult['memories']; candidateMemories: SearchResult['memories'] }> {
  if (!params.config.enabled) {
    params.debug?.basic('auto_recall.skipped', { reason: 'disabled' });
    return { block: '', source: 'none', memories: [], candidateMemories: [] };
  }

  params.debug?.basic('auto_recall.start', {
    userId: params.userId,
    topK: params.config.topK,
    scope: params.config.scope,
    ...summarizeText(params.query),
  });

  const sizing = deriveRecallSizing(params.config.topK);
  const candidateTopK = sizing.candidateTopK;
  const queryVariants = buildRecallQueryVariants(params.query);
  params.debug?.verbose('auto_recall.variants', {
    count: queryVariants.length,
    variants: queryVariants.map((variant) => ({ kind: variant.kind, ...summarizeText(variant.text) })),
  });
  const results = await Promise.all(
    queryVariants.map((variant) =>
      params.search({
        query: variant.text,
        userId: params.userId,
        sessionId: params.sessionId,
        agentId: params.agentId,
        topK: candidateTopK,
        filters: params.config.scope === 'long-term' ? { scope: 'long-term' } : undefined,
      }),
    ),
  );
  const result = mergeRecallSearchResults(results, queryVariants);

  if (!result.memories.length) {
    params.debug?.basic('auto_recall.empty', { source: result.source });
    return { block: '', source: result.source, memories: [], candidateMemories: [] };
  }

  const reranker = params.reranker || createLocalRecallReranker();
  const rerankedMemories = await reranker.rerank(result.memories, params.query);
  const selectedMemories = applyQueryAwareFinalBlend(rerankedMemories, params.query);
  const block = buildAutoRecallBlock(selectedMemories, params.config, result.source);
  params.debug?.basic('auto_recall.done', {
    source: result.source,
    hits: selectedMemories.length,
    injectedChars: block.length,
  });
  selectedMemories.forEach((memory) => {
    params.debug?.verbose('auto_recall.memory', {
      memoryUid: memory.memory_uid,
      scope: memory.scope,
      ...summarizeText(memory.text),
    });
  });
  return { block, source: result.source, memories: selectedMemories, candidateMemories: result.memories };
}

function mergeRecallSearchResults(results: SearchResult[], variants: ReturnType<typeof buildRecallQueryVariants>): SearchResult {
  const merged = new Map<string, { memory: SearchResult['memories'][number]; score: number }>();
  let source: SearchResult['source'] = 'none';

  results.forEach((result, variantIndex) => {
    if (source === 'none' && result.source !== 'none') {
      source = result.source;
    }

    const variantWeight = variants[variantIndex]?.weight ?? 1;
    result.memories.forEach((memory, index) => {
      const key = memory.memory_uid || `${memory.scope}:${memory.text}`;
      const rankScore = ((result.memories.length - index) / Math.max(result.memories.length, 1)) * variantWeight;
      const existing = merged.get(key);

      if (existing) {
        existing.score += rankScore;
        return;
      }

      merged.set(key, { memory, score: rankScore });
    });
  });

  return {
    source,
    memories: [...merged.values()]
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.memory),
  };
}

function applyQueryAwareFinalBlend(
  memories: SearchResult['memories'],
  query: string,
): SearchResult['memories'] {
  const normalizedQuery = normalizeText(query);

  return [...memories]
    .map((memory, index, items) => ({
      memory,
      score:
        ((items.length - index) / Math.max(items.length, 1))
        + computeQueryAwareBlendScore(memory, normalizedQuery),
    }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.memory);
}

function computeQueryAwareBlendScore(
  memory: SearchResult['memories'][number],
  normalizedQuery: string,
): number {
  const text = normalizeText(memory.text);
  if (!normalizedQuery || !text) {
    return 0;
  }

  return text === normalizedQuery ? -3 : 0;
}

function normalizeText(value: string): string {
  return String(value || '').trim().toLowerCase();
}
