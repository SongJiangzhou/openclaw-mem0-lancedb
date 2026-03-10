import assert from 'node:assert/strict';
import test from 'node:test';

import { PluginDebugLogger } from '../../src/debug/logger';
import { buildAutoRecallBlock, runAutoRecall } from '../../src/recall/auto';
import type { AutoRecallConfig, MemoryRecord } from '../../src/types';

function buildMemory(text: string, scope: 'long-term' | 'session' = 'long-term'): MemoryRecord {
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
