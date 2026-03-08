import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryStoreTool } from '../../src/tools/store';
import { HotMemorySearch } from '../../src/hot/search';

test('hot plane search returns canonical memory rows with filters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hot-search-'));

  try {
    const cfg = {
      lancedbPath: dir,
      mem0BaseUrl: '',
      mem0ApiKey: '',
      outboxDbPath: join(dir, 'outbox.json'),
      auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
      autoRecall: { enabled: false, topK: 5, maxChars: 800, scope: 'all' as const },
      autoCapture: { enabled: false, scope: 'long-term' as const, requireAssistantReply: true, maxCharsPerMessage: 2000 },
  embedding: { provider: "fake" as const, baseUrl: "", apiKey: "", model: "", dimension: 16 },
    };
    const store = new MemoryStoreTool(cfg);
    const hot = new HotMemorySearch(cfg);

    await store.execute({
      text: 'User preference: reply in English',
      userId: 'user-1',
      scope: 'long-term',
      categories: ['preference'],
    });
    await store.execute({
      text: 'User wants all answers explained in English',
      userId: 'user-1',
      scope: 'long-term',
      categories: ['preference'],
    });

    const result = await hot.search({
      query: 'English',
      userId: 'user-1',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    assert.equal(result.source, 'lancedb');
    assert.ok(result.memories.length >= 2);
    assert.equal(result.memories[0]?.user_id, 'user-1');
    assert.equal(result.memories[0]?.scope, 'long-term');
    assert.match(result.memories.map((row) => row.text).join('\n'), /reply in English/);
    assert.match(result.memories.map((row) => row.text).join('\n'), /explained in English/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hot plane hybrid search includes vector-only candidates through explicit fusion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hot-search-'));

  try {
    const cfg = {
      lancedbPath: dir,
      mem0BaseUrl: '',
      mem0ApiKey: '',
      outboxDbPath: join(dir, 'outbox.json'),
      auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
      autoRecall: { enabled: false, topK: 5, maxChars: 800, scope: 'all' as const },
      autoCapture: { enabled: false, scope: 'long-term' as const, requireAssistantReply: true, maxCharsPerMessage: 2000 },
  embedding: { provider: "fake" as const, baseUrl: "", apiKey: "", model: "", dimension: 16 },
    };
    const store = new MemoryStoreTool(cfg);
    const hot = new HotMemorySearch(cfg);

    await store.execute({
      text: 'apple apple apple',
      userId: 'user-1',
      scope: 'long-term',
      categories: ['keyword'],
    });
    await store.execute({
      text: 'banana banana banana',
      userId: 'user-1',
      scope: 'long-term',
      categories: ['vector'],
    });

    const result = await hot.search({
      query: 'apple',
      userId: 'user-1',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    assert.ok(result.memories.length >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hot plane exact token query ranks exact substring hit first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hot-search-'));

  try {
    const cfg = {
      lancedbPath: dir,
      mem0BaseUrl: '',
      mem0ApiKey: '',
      outboxDbPath: join(dir, 'outbox.json'),
      auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
      autoRecall: { enabled: false, topK: 5, maxChars: 800, scope: 'all' as const },
      autoCapture: { enabled: false, scope: 'long-term' as const, requireAssistantReply: true, maxCharsPerMessage: 2000 },
      embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
    };
    const store = new MemoryStoreTool(cfg);
    const hot = new HotMemorySearch(cfg);

    await store.execute({
      text: 'Session note: previous mem0 local test used token mem0-local-e2e-20260308-1156-ZP4M',
      userId: 'user-1',
      scope: 'long-term',
      categories: ['token'],
    });
    await store.execute({
      text: 'Session summary: mem0 local test completed successfully with various follow-up checks',
      userId: 'user-1',
      scope: 'long-term',
      categories: ['summary'],
    });
    await store.execute({
      text: 'Context: discussed local mem0 integration and semantic retrieval tuning',
      userId: 'user-1',
      scope: 'long-term',
      categories: ['context'],
    });

    const result = await hot.search({
      query: 'mem0-local-e2e-20260308-1156-ZP4M',
      userId: 'user-1',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    assert.ok(result.memories.length >= 1);
    assert.match(result.memories[0]?.text || '', /mem0-local-e2e-20260308-1156-ZP4M/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hot plane password-style question prefers the memory containing the exact token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hot-search-'));

  try {
    const cfg = {
      lancedbPath: dir,
      mem0BaseUrl: '',
      mem0ApiKey: '',
      outboxDbPath: join(dir, 'outbox.json'),
      auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
      autoRecall: { enabled: false, topK: 5, maxChars: 800, scope: 'all' as const },
      autoCapture: { enabled: false, scope: 'long-term' as const, requireAssistantReply: true, maxCharsPerMessage: 2000 },
      embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
    };
    const store = new MemoryStoreTool(cfg);
    const hot = new HotMemorySearch(cfg);

    await store.execute({
      text: '11:56 做 mem0 本地机制 E2E 时设置的测试口令是 mem0-local-e2e-20260308-1156-ZP4M。',
      userId: 'user-1',
      scope: 'long-term',
      categories: ['token'],
    });
    await store.execute({
      text: '11:56 做 mem0 本地机制 E2E，验证了自动提取和自动召回链路，但没有记录最终口令。',
      userId: 'user-1',
      scope: 'long-term',
      categories: ['summary'],
    });
    await store.execute({
      text: 'mem0 本地机制 E2E 复盘：主要问题在排序和融合策略，不在写入链路。',
      userId: 'user-1',
      scope: 'long-term',
      categories: ['analysis'],
    });

    const result = await hot.search({
      query: '11:56 做 mem0本地机制E2E 时设置的测试口令是什么',
      userId: 'user-1',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    assert.ok(result.memories.length >= 1);
    assert.match(result.memories[0]?.text || '', /mem0-local-e2e-20260308-1156-ZP4M/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
