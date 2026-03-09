import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryStoreTool } from '../../src/tools/store';
import { HotMemorySearch } from '../../src/hot/search';
import { openMemoryTable } from '../../src/db/table';

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

test('hot plane search deduplicates rows with identical text but different memory ids', async () => {
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
    const tbl = await openMemoryTable(dir, 16);
    await tbl.add([
      {
        memory_uid: 'dup-1',
        user_id: 'user-1',
        run_id: '',
        scope: 'long-term',
        text: 'User prefers Coke over Pepsi',
        categories: ['preference'],
        tags: [],
        memory_type: 'preference',
        domains: ['food'],
        source_kind: 'assistant_inferred',
        confidence: 0.9,
        ts_event: '2026-03-09T18:00:00.000Z',
        source: 'openclaw',
        status: 'active',
        sensitivity: 'internal',
        openclaw_refs: '{}',
        mem0_id: 'mem0-1',
        mem0_event_id: '',
        mem0_hash: 'hash-coke',
        lancedb_row_key: 'dup-1',
        vector: new Array(16).fill(0.2),
      },
      {
        memory_uid: 'dup-2',
        user_id: 'user-1',
        run_id: '',
        scope: 'long-term',
        text: 'User prefers Coke over Pepsi',
        categories: ['preference'],
        tags: [],
        memory_type: 'preference',
        domains: ['food'],
        source_kind: 'assistant_inferred',
        confidence: 0.8,
        ts_event: '2026-03-09T18:05:00.000Z',
        source: 'openclaw',
        status: 'active',
        sensitivity: 'internal',
        openclaw_refs: '{}',
        mem0_id: 'mem0-2',
        mem0_event_id: '',
        mem0_hash: 'hash-coke',
        lancedb_row_key: 'dup-2',
        vector: new Array(16).fill(0.2),
      },
    ]);
    const hot = new HotMemorySearch(cfg);

    const result = await hot.search({
      query: 'Which soda do I prefer?',
      userId: 'user-1',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    const cokeHits = result.memories.filter((memory) => memory.text === 'User prefers Coke over Pepsi');
    assert.equal(cokeHits.length, 1);
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

test('hot plane ranking penalizes metadata and test-token noise for non-credential preference queries', () => {
  const cfg = {
    lancedbPath: '',
    mem0BaseUrl: '',
    mem0ApiKey: '',
    outboxDbPath: '',
    auditStorePath: '',
    autoRecall: { enabled: false, topK: 5, maxChars: 800, scope: 'all' as const },
    autoCapture: { enabled: false, scope: 'long-term' as const, requireAssistantReply: true, maxCharsPerMessage: 2000 },
    embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
  };
  const hot = new HotMemorySearch(cfg as any);
  const now = new Date().toISOString();

  const ranked = (hot as any).applyRankingAdjustments(
    [
      {
        memory_uid: 'noise-metadata',
        text: "Client metadata payload: label 'generic-client', id 'generic-client', username 'generic-client'.",
        categories: ['metadata'],
        ts_event: now,
        __rrf_score: 1.2,
      },
      {
        memory_uid: 'noise-token',
        text: 'Integration test token for the local check is alpha-beta-gamma.',
        categories: ['token'],
        ts_event: now,
        __rrf_score: 1.1,
      },
      {
        memory_uid: 'user-preference',
        text: 'User likes Nintendo games and Mario titles.',
        categories: ['preference', 'game'],
        ts_event: now,
        __rrf_score: 0.45,
      },
    ],
    'What kind of games do I like?',
  );

  assert.equal(ranked[0]?.memory_uid, 'user-preference');
  assert.ok(ranked.findIndex((row: any) => row.memory_uid === 'noise-metadata') > 0);
  assert.ok(ranked.findIndex((row: any) => row.memory_uid === 'noise-token') > 0);
});

test('hot plane preference intent reranking boosts preference memories for game-like queries', () => {
  const cfg = {
    lancedbPath: '',
    mem0BaseUrl: '',
    mem0ApiKey: '',
    outboxDbPath: '',
    auditStorePath: '',
    autoRecall: { enabled: false, topK: 5, maxChars: 800, scope: 'all' as const },
    autoCapture: { enabled: false, scope: 'long-term' as const, requireAssistantReply: true, maxCharsPerMessage: 2000 },
    embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
  };
  const hot = new HotMemorySearch(cfg as any);
  const now = new Date().toISOString();

  const ranked = (hot as any).applyRankingAdjustments(
    [
      {
        memory_uid: 'profile-work',
        text: 'User works at a technology company and uses C++ and Python.',
        categories: ['profile', 'work'],
        ts_event: now,
        __rrf_score: 1.0,
      },
      {
        memory_uid: 'game-preference',
        text: 'User likes Nintendo games, including Mario and Zelda titles.',
        categories: ['preference', 'game'],
        ts_event: now,
        __rrf_score: 0.4,
      },
    ],
    'What kind of games do I like?',
  );

  assert.equal(ranked[0]?.memory_uid, 'game-preference');
});
