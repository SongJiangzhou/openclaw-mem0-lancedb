import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginDebugLogger } from '../../src/debug/logger';
import { buildAutoRecallBlock, runAutoRecall } from '../../src/recall/auto';
import { buildRecallQueryVariants, type RecallQueryVariant } from '../../src/recall/query-rewrite';
import type { RecallReranker } from '../../src/recall/reranker';
import type { AutoRecallConfig, MemoryRecord } from '../../src/types';

function buildMemory(
  text: string,
  scope: 'long-term' | 'session' = 'long-term',
  overrides?: Partial<MemoryRecord>,
): MemoryRecord {
  return {
    memory_uid: `m-${text}`,
    user_id: 'user-1',
    run_id: null,
    scope,
    text,
    categories: ['preference'],
    tags: [],
    ts_event: '2026-03-07T12:00:00.000Z',
    source: 'openclaw',
    status: 'active',
    sensitivity: 'internal',
    openclaw_refs: { file_path: 'MEMORY.md' },
    mem0: {},
    lancedb: {},
    ...overrides,
  };
}

function buildConfig(overrides?: Partial<AutoRecallConfig>): AutoRecallConfig {
  return {
    enabled: true,
    topK: 2,
    maxChars: 200,
    scope: 'all',
    ...overrides,
  };
}

test('buildAutoRecallBlock formats stable recall block', () => {
  const block = buildAutoRecallBlock(
    [buildMemory('User preference: reply in English'), buildMemory('User likes sci-fi movies')],
    buildConfig(),
  );

  assert.match(block, /<recall/);
  assert.match(block, /reply in English/);
  assert.match(block, /User likes sci-fi movies/);
  assert.match(block, /<\/recall>/);
});

test('buildAutoRecallBlock includes source attribute when provided', () => {
  const block = buildAutoRecallBlock(
    [buildMemory('User preference: reply in English')],
    buildConfig(),
    'lancedb',
  );

  assert.match(block, /source="lancedb"/);
});

test('buildAutoRecallBlock respects maxChars by dropping whole lower-priority entries', () => {
  const block = buildAutoRecallBlock(
    [
      buildMemory('User prefers Coke over Pepsi'),
      buildMemory('User also likes long detailed descriptions about beverage preferences and brand comparisons'),
    ],
    buildConfig({ topK: 2, maxChars: 90 }),
    'lancedb',
  );

  assert.match(block, /User prefers Coke over Pepsi/);
  assert.doesNotMatch(block, /brand comparisons/);
  assert.match(block, /<\/recall>$/);
  assert.ok(block.length <= 90);
});

test('buildAutoRecallBlock preserves a valid block when maxChars is smaller than a single entry', () => {
  const block = buildAutoRecallBlock(
    [buildMemory('User prefers replies in English and values concise summaries.')],
    buildConfig({ topK: 1, maxChars: 55 }),
    'lancedb',
  );

  assert.match(block, /^<recall source="lancedb">/);
  assert.match(block, /\.\.\./);
  assert.match(block, /<\/recall>$/);
  assert.ok(block.length <= 55);
});

test('runAutoRecall applies topK and maxChars constraints', async () => {
  const result = await runAutoRecall({
    query: 'English',
    userId: 'user-1',
    config: buildConfig({ topK: 1, maxChars: 200 }),
    search: async () => ({
      memories: [
        buildMemory('User preference: reply in English'),
        buildMemory('User likes sci-fi movies'),
      ],
      source: 'lancedb',
    }),
  });

  assert.ok(result.block);
  assert.match(result.block, /User preference/);
  assert.doesNotMatch(result.block, /User likes sci-fi movies/);
  assert.ok(result.block.length <= 200);
  assert.equal(result.source, 'lancedb');
  assert.equal(result.memories.length, 1);
  assert.equal(result.candidateMemories.length, 2);
});

test('runAutoRecall fetches a wider candidate pool than the final injected topK', async () => {
  let requestedTopK = 0;

  await runAutoRecall({
    query: 'What do I prefer to drink?',
    userId: 'user-1',
    config: buildConfig({ topK: 2, maxChars: 200 }),
    search: async (input) => {
      requestedTopK = input.topK;
      return {
        memories: [buildMemory('User prefers Coke over Pepsi')],
        source: 'lancedb',
      };
    },
  });

  assert.ok(requestedTopK > 2);
});

test('buildRecallQueryVariants extracts a focused retrieval query from longer prompts', () => {
  const variants = buildRecallQueryVariants(
    'Based on earlier notes and recent auto-capture results, can you tell me what I like to eat at McDonalds? Keep it short.',
  );

  assert.equal(variants[0]?.kind, 'original');
  assert.ok(variants.some((variant: RecallQueryVariant) => variant.kind === 'compressed'));
  assert.ok(variants.some((variant: RecallQueryVariant) => /what i like to eat at mcdonalds/i.test(variant.text)));
});

test('buildRecallQueryVariants strips host metadata wrappers before compression', () => {
  const variants = buildRecallQueryVariants(
    'Sender (untrusted metadata):\n[Wed 2026-03-10 02:45 GMT+8] What foods do I like at McDonalds?\n```json\n{"message_id":"1"}\n```',
  );

  assert.ok(variants.every((variant: RecallQueryVariant) => !/Sender \(untrusted metadata\)/i.test(variant.text)));
  assert.ok(variants.some((variant: RecallQueryVariant) => /What foods do I like at McDonalds\?/i.test(variant.text)));
});

test('runAutoRecall merges multi-query candidates so compressed queries can rescue relevant memories', async () => {
  const queries: string[] = [];

  const result = await runAutoRecall({
    query: 'Based on earlier notes and recent auto-capture results, can you tell me what I like to eat at McDonalds? Keep it short.',
    userId: 'user-1',
    config: buildConfig({ topK: 1, maxChars: 200 }),
    search: async (input) => {
      queries.push(input.query);
      if (/what i like to eat at mcdonalds/i.test(input.query)) {
        return {
          memories: [
            buildMemory('User likes McDonalds grilled chicken burger'),
            buildMemory('User likes McDonalds McFlurry'),
          ],
          source: 'lancedb',
        };
      }

      return {
        memories: [
          buildMemory('User likes strategy games'),
          buildMemory('User likes puzzle games'),
        ],
        source: 'lancedb',
      };
    },
  });

  assert.ok(queries.length > 1);
  assert.match(result.block, /McDonalds/);
  assert.doesNotMatch(result.block, /strategy games|puzzle games/);
});

test('runAutoRecall reranks entity-matching memories ahead of generic domain matches', async () => {
  const result = await runAutoRecall({
    query: 'What do I like at McDonalds?',
    userId: 'user-1',
    config: buildConfig({ topK: 1, maxChars: 200 }),
    search: async () => ({
      memories: [
        buildMemory('User likes KFC egg tarts'),
        buildMemory('User likes McDonalds grilled chicken burger'),
        buildMemory('User likes Coke'),
      ],
      source: 'lancedb',
    }),
  });

  assert.match(result.block, /McDonalds grilled chicken burger/);
  assert.doesNotMatch(result.block, /KFC egg tarts/);
});

test('runAutoRecall supports injected rerankers for future extension', async () => {
  let invoked = false;
  const reranker: RecallReranker = {
    async rerank(memories) {
      invoked = true;
      return [memories[1], memories[0]].filter(Boolean);
    },
  };

  const result = await runAutoRecall({
    query: 'Which soda do I prefer?',
    userId: 'user-1',
    config: buildConfig({ topK: 1, maxChars: 200 }),
    reranker,
    search: async () => ({
      memories: [
        buildMemory('User prefers Pepsi'),
        buildMemory('User prefers Coke'),
      ],
      source: 'lancedb',
    }),
  });

  assert.equal(invoked, true);
  assert.match(result.block, /User prefers Coke/);
});

test('runAutoRecall reranks lowercase english entity queries without stopword stripping rules', async () => {
  const result = await runAutoRecall({
    query: 'what do i like at mcdonalds',
    userId: 'user-1',
    config: buildConfig({ topK: 1, maxChars: 200 }),
    search: async () => ({
      memories: [
        buildMemory('User likes KFC egg tarts'),
        buildMemory('User likes McDonalds grilled chicken burger'),
        buildMemory('User likes Coke'),
      ],
      source: 'lancedb',
    }),
  });

  assert.match(result.block, /McDonalds grilled chicken burger/);
  assert.doesNotMatch(result.block, /KFC egg tarts/);
});

test('runAutoRecall downranks query echo memories', async () => {
  const result = await runAutoRecall({
    query: 'What do I like at McDonalds?',
    userId: 'user-1',
    config: buildConfig({ topK: 1, maxChars: 200 }),
    search: async () => ({
      memories: [
        buildMemory('What do I like at McDonalds?'),
        buildMemory('User likes McDonalds grilled chicken burger'),
      ],
      source: 'lancedb',
    }),
  });

  assert.match(result.block, /McDonalds grilled chicken burger/);
  assert.doesNotMatch(result.block, /^.*What do I like at McDonalds\?.*$/m);
});

test('runAutoRecall downranks operational path noise behind relevant preferences', async () => {
  const result = await runAutoRecall({
    query: 'What do I like at McDonalds?',
    userId: 'user-1',
    config: buildConfig({ topK: 2, maxChars: 200 }),
    search: async () => ({
      memories: [
        buildMemory('Data written to /workspace/data/stock_daily/2026-03-10.jsonl'),
        buildMemory('User likes McDonalds grilled chicken burger'),
        buildMemory('User likes McDonalds McFlurry'),
      ],
      source: 'lancedb',
    }),
  });

  const lines = result.block.split('\n').filter((line) => line.startsWith('- '));
  assert.match(lines[0] || '', /McDonalds grilled chicken burger/);
  assert.doesNotMatch(result.block, /stock_daily/);
});

test('runAutoRecall downranks generic McDonalds query-like memories behind concrete foods', async () => {
  const result = await runAutoRecall({
    query: 'What foods do I like at McDonalds?',
    userId: 'user-1',
    config: buildConfig({ topK: 2, maxChars: 200 }),
    search: async () => ({
      memories: [
        buildMemory('What foods do I like at McDonalds?'),
        buildMemory('User likes McDonalds McFlurry'),
        buildMemory('User likes McDonalds grilled chicken burger'),
        buildMemory('User likes KFC egg tarts'),
      ],
      source: 'lancedb',
    }),
  });

  const lines = result.block.split('\n').filter((line) => line.startsWith('- '));
  assert.match(lines[0] || '', /McDonalds/);
  assert.doesNotMatch(lines[0] || '', /What foods do I like at McDonalds/);
  assert.doesNotMatch(result.block, /^.*What foods do I like at McDonalds\?.*$/m);
});

test('runAutoRecall returns empty block when search result is empty', async () => {
  const result = await runAutoRecall({
    query: 'English',
    userId: 'user-1',
    config: buildConfig(),
    search: async () => ({ memories: [], source: 'none' }),
  });

  assert.equal(result.block, '');
  assert.equal(result.source, 'none');
});

test('runAutoRecall emits debug events with hit summaries', async () => {
  const messages: string[] = [];
  const debug = new PluginDebugLogger(
    { mode: 'verbose' },
    { info: (msg: string) => messages.push(msg), warn: (msg: string) => messages.push(msg), error: (msg: string) => messages.push(msg) },
  );

  await runAutoRecall({
    query: 'English replies',
    userId: 'user-1',
    config: buildConfig(),
    debug,
    search: async () => ({ memories: [buildMemory('User preference: reply in English')], source: 'lancedb' }),
  });

  const output = messages.join('\n');
  assert.match(output, /auto_recall\.start/);
  assert.match(output, /auto_recall\.done/);
  assert.match(output, /reply in English/);
});
