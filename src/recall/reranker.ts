import type { RecallRerankerConfig, SearchResult } from '../types';
import { PluginDebugLogger, type PluginLogger } from '../debug/logger';
import { stripPunctuation, longestCommonSubstringLength } from '../memory/text-utils';

const BASE_RANK_SCALE = 1;
const SUBSTRING_MATCH_BOOST = 1.5;
const LCS_SCALE = 2.5;
const BIGRAM_SCALE = 1.5;
const QUERY_ECHO_PENALTY = 3;
const CURRENT_TEMPORAL_BONUS = 0.8;
const RECENT_TEMPORAL_BONUS = 0.45;
const HISTORICAL_TEMPORAL_PENALTY = 0.35;
const USER_EXPLICIT_BONUS = 0.4;
const ASSISTANT_INFERRED_PENALTY = 0.15;

export interface RecallReranker {
  rerank(memories: SearchResult['memories'], query: string): Promise<SearchResult['memories']>;
}

export function createLocalRecallReranker(): RecallReranker {
  return {
    async rerank(memories, query) {
      const normalizedQuery = stripPunctuation(query);

      return [...memories]
        .map((memory, index) => ({
          memory,
          score: computeRecallScore(memory.text, normalizedQuery, index, memories.length)
            + computeSemanticBlendScore(memory),
        }))
        .sort((left, right) => right.score - left.score)
        .map((entry) => entry.memory);
    },
  };
}

export function createRecallReranker(
  config?: RecallRerankerConfig,
  fetchFn: typeof fetch = fetch,
  logger?: PluginLogger,
): RecallReranker {
  if (!config || config.provider === 'local') {
    return createLocalRecallReranker();
  }

  if (config.provider === 'none') {
    return {
      async rerank(memories) {
        return memories;
      },
    };
  }

  if (config.provider !== 'voyage') {
    return createLocalRecallReranker();
  }

  const localFallback = createLocalRecallReranker();
  const recallLogger = logger || new PluginDebugLogger({ mode: 'off' }).child('memory.reranker');
  return {
    async rerank(memories, query) {
      try {
        const ranked = await rerankWithVoyage(memories, query, config, fetchFn);
        return applyFinalBlend(ranked);
      } catch (error) {
        recallLogger.exception('memory_reranker.remote_failed', error, {
          provider: config.provider,
          memoryCount: memories.length,
        });
        return localFallback.rerank(memories, query);
      }
    },
  };
}

async function rerankWithVoyage(
  memories: SearchResult['memories'],
  query: string,
  config: RecallRerankerConfig,
  fetchFn: typeof fetch,
): Promise<SearchResult['memories']> {
  if (memories.length <= 1) {
    return memories;
  }

  const baseUrl = (config.baseUrl || 'https://api.voyageai.com/v1').replace(/\/$/, '');
  const response = await fetchFn(`${baseUrl}/rerank`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || 'rerank-2.5-lite',
      query,
      documents: memories.map((memory) => buildSemanticRerankDocument(memory)),
    }),
  });

  if (!response.ok) {
    throw new Error(`Voyage rerank request failed with status ${response.status}`);
  }

  const body = await response.json() as { data?: Array<{ index?: number; relevance_score?: number }> };
  const scored = body.data ?? [];
  const rankedIndexes = new Set<number>();
  const reranked: SearchResult['memories'] = [];

  scored
    .sort((left, right) => (right.relevance_score ?? 0) - (left.relevance_score ?? 0))
    .forEach((entry) => {
      const index = entry.index;
      if (typeof index !== 'number' || index < 0 || index >= memories.length || rankedIndexes.has(index)) {
        return;
      }
      rankedIndexes.add(index);
      reranked.push(memories[index]!);
    });

  memories.forEach((memory, index) => {
    if (!rankedIndexes.has(index)) {
      reranked.push(memory);
    }
  });

  return reranked;
}

function applyFinalBlend(memories: SearchResult['memories']): SearchResult['memories'] {
  return [...memories]
    .map((memory, index, items) => ({
      memory,
      score: ((items.length - index) / Math.max(items.length, 1)) + computeSemanticBlendScore(memory),
    }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.memory);
}

function buildSemanticRerankDocument(memory: SearchResult['memories'][number]): string {
  const temporalHint = deriveTemporalHint(memory);
  const memoryType = memory.memory_type || 'generic';
  const domain = Array.isArray(memory.domains) && memory.domains.length > 0 ? memory.domains[0] : 'generic';
  const sourceKind = memory.source_kind || 'assistant_inferred';
  return `memory_type=${memoryType}; domain=${domain}; source=${sourceKind}; recency=${temporalHint}; text=${memory.text}`;
}

function computeSemanticBlendScore(memory: SearchResult['memories'][number]): number {
  let score = 0;
  const temporalHint = deriveTemporalHint(memory);

  if (memory.source_kind === 'user_explicit') {
    score += USER_EXPLICIT_BONUS;
  } else if (memory.source_kind === 'assistant_inferred') {
    score -= ASSISTANT_INFERRED_PENALTY;
  }

  if (temporalHint === 'current') {
    score += CURRENT_TEMPORAL_BONUS;
  } else if (temporalHint === 'recent') {
    score += RECENT_TEMPORAL_BONUS;
  } else if (temporalHint === 'historical') {
    score -= HISTORICAL_TEMPORAL_PENALTY;
  }

  return score;
}

function deriveTemporalHint(memory: SearchResult['memories'][number]): 'current' | 'recent' | 'older' | 'historical' {
  const rawTs = memory.last_access_ts || memory.ts_event;
  const timestamp = rawTs ? new Date(rawTs).getTime() : NaN;
  if (!Number.isFinite(timestamp)) {
    return 'older';
  }

  const ageDays = Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60 * 24));

  if (memory.lifecycle_state === 'reinforced' || ageDays <= 3) {
    return 'current';
  }
  if (ageDays <= 30) {
    return 'recent';
  }
  if (ageDays <= 180) {
    return 'older';
  }
  return 'historical';
}

function computeRecallScore(text: string, normalizedQuery: string, index: number, total: number): number {
  const normalizedText = stripPunctuation(text);
  let score = (Math.max(total - index, 1) / Math.max(total, 1)) * BASE_RANK_SCALE;

  if (!normalizedQuery || !normalizedText) {
    return score;
  }

  if (normalizedText === normalizedQuery) {
    return score - QUERY_ECHO_PENALTY;
  }

  if (normalizedText.includes(normalizedQuery) || normalizedQuery.includes(normalizedText)) {
    score += SUBSTRING_MATCH_BOOST;
  }

  const lcsLength = longestCommonSubstringLength(normalizedQuery, normalizedText);
  score += (lcsLength / Math.max(normalizedQuery.length, 1)) * LCS_SCALE;

  const queryBigrams = buildBigrams(normalizedQuery);
  const textBigrams = buildBigrams(normalizedText);
  const overlap = jaccardSimilarity(queryBigrams, textBigrams);
  score += overlap * BIGRAM_SCALE;

  return score;
}

function buildBigrams(text: string): Set<string> {
  const values = new Set<string>();
  if (text.length < 2) {
    if (text) {
      values.add(text);
    }
    return values;
  }

  for (let i = 0; i < text.length - 1; i++) {
    values.add(text.slice(i, i + 2));
  }
  return values;
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  left.forEach((value) => {
    if (right.has(value)) {
      intersection += 1;
    }
  });

  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}
