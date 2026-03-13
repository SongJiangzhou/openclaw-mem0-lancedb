import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryStoreTool } from '../../src/tools/store';
import { HotMemorySearch } from '../../src/hot/search';
import { openMemoryTable } from '../../src/db/table';
import { PluginDebugLogger } from '../../src/debug/logger';
import * as embedder from '../../src/hot/embedder';
import * as tableDiscovery from '../../src/hot/table-discovery';
import * as dbTable from '../../src/db/table';

test('hot plane search returns canonical memory rows with filters', { concurrency: false }, async () => {
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
      userId: 'default',
      scope: 'long-term',
      categories: ['preference'],
    });
    await store.execute({
      text: 'User wants all answers explained in English',
      userId: 'default',
      scope: 'long-term',
      categories: ['preference'],
    });

    const result = await hot.search({
      query: 'English',
      userId: 'default',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    assert.equal(result.source, 'lancedb');
    assert.ok(result.memories.length >= 2);
    assert.equal(result.memories[0]?.user_id, 'default');
    assert.equal(result.memories[0]?.scope, 'long-term');
    assert.match(result.memories.map((row) => row.text).join('\n'), /reply in English/);
    assert.match(result.memories.map((row) => row.text).join('\n'), /explained in English/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hot plane hybrid search includes vector-only candidates through explicit fusion', { concurrency: false }, async () => {
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
      userId: 'default',
      scope: 'long-term',
      categories: ['keyword'],
    });
    await store.execute({
      text: 'banana banana banana',
      userId: 'default',
      scope: 'long-term',
      categories: ['vector'],
    });

    const result = await hot.search({
      query: 'apple',
      userId: 'default',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    assert.ok(result.memories.length >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hot plane exact token query ranks exact substring hit first', { concurrency: false }, async () => {
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
      userId: 'default',
      scope: 'long-term',
      categories: ['token'],
    });
    await store.execute({
      text: 'Session summary: mem0 local test completed successfully with various follow-up checks',
      userId: 'default',
      scope: 'long-term',
      categories: ['summary'],
    });
    await store.execute({
      text: 'Context: discussed local mem0 integration and semantic retrieval tuning',
      userId: 'default',
      scope: 'long-term',
      categories: ['context'],
    });

    const result = await hot.search({
      query: 'mem0-local-e2e-20260308-1156-ZP4M',
      userId: 'default',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    assert.ok(result.memories.length >= 1);
    assert.match(result.memories[0]?.text || '', /mem0-local-e2e-20260308-1156-ZP4M/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hot plane search uses shared primary and secondary fetch sizing', async () => {
  const cfg = {
    lancedbPath: '/tmp/unused',
    mem0BaseUrl: '',
    mem0ApiKey: '',
    outboxDbPath: '/tmp/outbox.json',
    auditStorePath: '/tmp/audit.jsonl',
    autoRecall: { enabled: false, topK: 5, maxChars: 800, scope: 'all' as const },
    autoCapture: { enabled: false, scope: 'long-term' as const, requireAssistantReply: true, maxCharsPerMessage: 2000 },
    embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
  };
  const hot = new HotMemorySearch(cfg);
  const seenFtsTopK: number[] = [];
  const seenVectorTopK: number[] = [];
  const tableDiscoveryAny = tableDiscovery as any;
  const dbTableAny = dbTable as any;
  const originalDiscoverMemoryTables = tableDiscovery.discoverMemoryTables;
  const originalOpenMemoryTable = dbTable.openMemoryTable;
  const hotAny = hot as any;
  const originalSearchFts = hotAny.searchFts;
  const originalSearchVector = hotAny.searchVector;
  const originalToMemoryRecord = hotAny.toMemoryRecord;

  tableDiscoveryAny.discoverMemoryTables = async () => [
    { dimension: 16, name: 'memory_records' },
    { dimension: 32, name: 'memory_records_d32' },
  ];
  dbTableAny.openMemoryTable = async () => ({}) as any;
  hotAny.searchFts = async (_tbl: unknown, _query: string, _where: string, topK: number) => {
    seenFtsTopK.push(topK);
    return [];
  };
  hotAny.searchVector = async (_tbl: unknown, _vector: number[] | null, _where: string, topK: number) => {
    seenVectorTopK.push(topK);
    return [];
  };
  hotAny.toMemoryRecord = (row: any) => row;

  try {
    const result = await hot.search({
      query: 'English',
      userId: 'default',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    assert.deepEqual(result.memories, []);
    assert.deepEqual(seenVectorTopK, [72]);
    assert.deepEqual(seenFtsTopK, [72, 48]);
  } finally {
    tableDiscoveryAny.discoverMemoryTables = originalDiscoverMemoryTables;
    dbTableAny.openMemoryTable = originalOpenMemoryTable;
    hotAny.searchFts = originalSearchFts;
    hotAny.searchVector = originalSearchVector;
    hotAny.toMemoryRecord = originalToMemoryRecord;
  }
});

test('hot plane search deduplicates rows with identical text but different memory ids', { concurrency: false }, async () => {
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
        user_id: 'default',
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
        user_id: 'default',
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
      userId: 'default',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    const cokeHits = result.memories.filter((memory) => memory.text === 'User prefers Coke over Pepsi');
    assert.equal(cokeHits.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hot plane search logs embedding failures and falls back to ranked rows', { concurrency: false }, async () => {
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
      embedding: { provider: 'voyage-invalid' as any, baseUrl: '', apiKey: '', model: '', dimension: 16 },
    };
    const tbl = await openMemoryTable(dir, 16);
    const logs: string[] = [];
    const logger = new PluginDebugLogger(
      { mode: 'debug' },
      {
        info: (msg: string) => logs.push(msg),
        warn: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
      },
    );
    const hot = new HotMemorySearch(cfg, logger.child('memory.hot_search'));

    await tbl.add([{
      memory_uid: 'fallback-1',
      user_id: 'default',
      run_id: '',
      scope: 'long-term',
      text: 'User prefers grilled chicken burgers at McDonalds',
      categories: ['preference'],
      tags: [],
      memory_type: 'preference',
      domains: ['food'],
      source_kind: 'user_explicit',
      confidence: 0.9,
      ts_event: '2026-03-11T00:00:00.000Z',
      source: 'openclaw',
      status: 'active',
      sensitivity: 'internal',
      openclaw_refs: '{}',
      mem0_id: '',
      mem0_event_id: '',
      mem0_hash: '',
      lancedb_row_key: 'fallback-1',
      vector: new Array(16).fill(0.3),
    }]);

    const result = await hot.search({
      query: 'McDonalds',
      userId: 'default',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    assert.equal(result.source, 'lancedb');
    assert.ok(result.memories.length >= 1);
    assert.match(result.memories[0]?.text || '', /McDonalds/);
    assert.ok(logs.some((line) => line.includes('"event":"memory_hot_search.query_embedding_failed"')));
    assert.ok(logs.some((line) => line.includes('"event":"memory_hot_search.mmr_fallback"')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hot plane search reuses a single query embedding for vector search and MMR', { concurrency: false }, async () => {
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
    const originalEmbed = embedder.embedText;
    let callCount = 0;
    (embedder as any).embedText = async (...args: unknown[]) => {
      callCount += 1;
      return originalEmbed(...args as [string, typeof cfg.embedding]);
    };

    try {
      await store.execute({
        text: 'User prefers grilled chicken burgers at McDonalds',
        userId: 'default',
        scope: 'long-term',
        categories: ['preference'],
      });

      const result = await hot.search({
        query: 'McDonalds grilled chicken burger',
        userId: 'default',
        topK: 5,
        filters: { scope: 'long-term' },
      });

      assert.ok(result.memories.length >= 1);
      assert.equal(callCount, 2);
    } finally {
      (embedder as any).embedText = originalEmbed;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hot plane password-style question prefers the memory containing the exact token', { concurrency: false }, async () => {
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
      text: 'The test passcode set during the local mem0 E2E run at 11:56 was mem0-local-e2e-20260308-1156-ZP4M.',
      userId: 'default',
      scope: 'long-term',
      categories: ['token'],
    });
    await store.execute({
      text: 'At 11:56, the local mem0 E2E run verified auto-capture and auto-recall, but did not record the final passcode.',
      userId: 'default',
      scope: 'long-term',
      categories: ['summary'],
    });
    await store.execute({
      text: 'Local mem0 E2E retrospective: the main issue was ranking and fusion strategy, not the write path.',
      userId: 'default',
      scope: 'long-term',
      categories: ['analysis'],
    });

    const result = await hot.search({
      query: 'What passcode was set during the local mem0 E2E run at 11:56?',
      userId: 'default',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    assert.ok(result.memories.length >= 1);
    assert.match(result.memories[0]?.text || '', /mem0-local-e2e-20260308-1156-ZP4M/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hot plane ranking penalizes metadata and test-token noise for non-credential preference queries', { concurrency: false }, () => {
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
        text: 'User likes strategy games and puzzle titles.',
        categories: ['preference', 'game'],
        ts_event: now,
        __rrf_score: 0.45,
      },
    ],
    'What kind of games do I like?',
  );

  assert.equal(ranked[0]?.memory_uid, 'user-preference');
  assert.equal(ranked.some((row: any) => row.memory_uid === 'noise-metadata'), false);
  assert.equal(ranked.some((row: any) => row.memory_uid === 'noise-token'), false);
});

test('hot plane preference intent reranking boosts preference memories for game-like queries', { concurrency: false }, () => {
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
        text: 'User likes strategy games, including city-builders and turn-based tactics.',
        categories: ['preference', 'game'],
        ts_event: now,
        __rrf_score: 0.4,
      },
    ],
    'What kind of games do I like?',
  );

  assert.equal(ranked[0]?.memory_uid, 'game-preference');
});

test('hot plane ranking prefers concise preference memories over long summaries', { concurrency: false }, () => {
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
        memory_uid: 'long-summary',
        text: 'The user talked at length about fast food preferences, comparing several restaurants, discussing texture, sauce balance, and meal combinations before eventually mentioning that McDonald\'s grilled chicken leg burger was one item among several possibilities.',
        categories: ['preference', 'food'],
        memory_type: 'preference',
        source_kind: 'assistant_inferred',
        confidence: 0.75,
        ts_event: now,
        __rrf_score: 0.9,
      },
      {
        memory_uid: 'concise-preference',
        text: 'User likes McDonald\'s grilled chicken leg burger.',
        categories: ['preference', 'food'],
        memory_type: 'preference',
        source_kind: 'user_explicit',
        confidence: 0.95,
        ts_event: now,
        __rrf_score: 0.8,
      },
    ],
    'What do I like to eat at McDonald\'s?',
  );

  assert.equal(ranked[0]?.memory_uid, 'concise-preference');
});

test('hot plane ranking fades stale weak memories behind fresher stronger peers', { concurrency: false }, () => {
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

  const ranked = (hot as any).applyRankingAdjustments(
    [
      {
        memory_uid: 'stale-low',
        text: 'User likes grilled chicken burgers.',
        categories: ['preference', 'food'],
        memory_type: 'preference',
        source_kind: 'assistant_inferred',
        confidence: 0.5,
        ts_event: '2026-01-01T00:00:00.000Z',
        last_access_ts: '2026-01-01T00:00:00.000Z',
        stability: 10,
        strength: 0.25,
        utility_score: 0.2,
        lifecycle_state: 'active',
        __rrf_score: 0.9,
      },
      {
        memory_uid: 'fresh-strong',
        text: 'User likes grilled chicken burgers.',
        categories: ['preference', 'food'],
        memory_type: 'preference',
        source_kind: 'user_explicit',
        confidence: 0.95,
        ts_event: '2026-03-12T00:00:00.000Z',
        last_access_ts: '2026-03-12T00:00:00.000Z',
        stability: 30,
        strength: 0.8,
        utility_score: 0.8,
        lifecycle_state: 'active',
        __rrf_score: 0.8,
      },
    ],
    'What kind of grilled chicken burgers do I like?',
  );

  assert.equal(ranked[0]?.memory_uid, 'fresh-strong');
});

test('hot plane lifecycle filtering excludes quarantined and expired memories', { concurrency: false }, async () => {
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
    const now = new Date().toISOString();
    await tbl.add([
      {
        memory_uid: 'active-1',
        user_id: 'default',
        run_id: '',
        scope: 'long-term',
        text: 'User likes grilled chicken burgers.',
        categories: ['preference'],
        tags: [],
        memory_type: 'preference',
        domains: ['food'],
        source_kind: 'user_explicit',
        confidence: 0.9,
        ts_event: now,
        source: 'openclaw',
        status: 'active',
        sensitivity: 'internal',
        strength: 0.9,
        stability: 60,
        last_access_ts: now,
        next_review_ts: now,
        access_count: 3,
        inhibition_weight: 0,
        inhibition_until: '',
        utility_score: 0.9,
        risk_score: 0.5,
        retention_deadline: '2026-12-31T00:00:00.000Z',
        lifecycle_state: 'active',
        openclaw_refs: '{}',
        mem0_id: '',
        mem0_event_id: '',
        mem0_hash: '',
        lancedb_row_key: 'active-1',
        vector: new Array(16).fill(0.1),
      },
      {
        memory_uid: 'quarantined-1',
        user_id: 'default',
        run_id: '',
        scope: 'long-term',
        text: 'What foods do I like at McDonalds?',
        categories: ['preference'],
        tags: [],
        memory_type: 'preference',
        domains: ['food'],
        source_kind: 'assistant_inferred',
        confidence: 0.7,
        ts_event: now,
        source: 'openclaw',
        status: 'active',
        sensitivity: 'internal',
        strength: 0.6,
        stability: 30,
        last_access_ts: now,
        next_review_ts: now,
        access_count: 0,
        inhibition_weight: 0,
        inhibition_until: '',
        utility_score: 0.4,
        risk_score: 0.5,
        retention_deadline: '2026-12-31T00:00:00.000Z',
        lifecycle_state: 'quarantined',
        openclaw_refs: '{}',
        mem0_id: '',
        mem0_event_id: '',
        mem0_hash: '',
        lancedb_row_key: 'quarantined-1',
        vector: new Array(16).fill(0.1),
      },
      {
        memory_uid: 'expired-1',
        user_id: 'default',
        run_id: '',
        scope: 'long-term',
        text: 'User used to like fried chicken.',
        categories: ['preference'],
        tags: [],
        memory_type: 'preference',
        domains: ['food'],
        source_kind: 'user_explicit',
        confidence: 0.7,
        ts_event: now,
        source: 'openclaw',
        status: 'active',
        sensitivity: 'internal',
        strength: 0.5,
        stability: 30,
        last_access_ts: now,
        next_review_ts: now,
        access_count: 0,
        inhibition_weight: 0,
        inhibition_until: '',
        utility_score: 0.3,
        risk_score: 0.5,
        retention_deadline: '2025-01-01T00:00:00.000Z',
        lifecycle_state: 'active',
        openclaw_refs: '{}',
        mem0_id: '',
        mem0_event_id: '',
        mem0_hash: '',
        lancedb_row_key: 'expired-1',
        vector: new Array(16).fill(0.1),
      },
    ]);
    const hot = new HotMemorySearch(cfg);

    const result = await hot.search({
      query: 'grilled chicken',
      userId: 'default',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    assert.ok(result.memories.some((memory) => memory.memory_uid === 'active-1'));
    assert.equal(result.memories.some((memory) => memory.memory_uid === 'quarantined-1'), false);
    assert.equal(result.memories.some((memory) => memory.memory_uid === 'expired-1'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hot plane ranking prefers higher-confidence explicit memories over inferred ones', { concurrency: false }, () => {
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
        memory_uid: 'assistant-inferred',
        text: 'User likes McDonald\'s grilled chicken leg burger.',
        categories: ['preference', 'food'],
        memory_type: 'preference',
        source_kind: 'assistant_inferred',
        confidence: 0.6,
        ts_event: now,
        __rrf_score: 0.8,
      },
      {
        memory_uid: 'user-explicit',
        text: 'User likes McDonald\'s grilled chicken leg burger.',
        categories: ['preference', 'food'],
        memory_type: 'preference',
        source_kind: 'user_explicit',
        confidence: 0.95,
        ts_event: now,
        __rrf_score: 0.8,
      },
    ],
    'What do I like to eat at McDonald\'s?',
  );

  assert.equal(ranked[0]?.memory_uid, 'user-explicit');
});

test('hot plane keeps session memories isolated while long-term memories stay shared', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hot-search-session-'));

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
      text: 'User prefers sparkling water over soda.',
      scope: 'long-term',
      categories: ['preference'],
    });
    await store.execute({
      text: 'Session A task: finalize deployment checklist.',
      scope: 'session',
      sessionId: 'session-a',
      categories: ['task'],
    });
    await store.execute({
      text: 'Session B task: review quarterly budget.',
      scope: 'session',
      sessionId: 'session-b',
      categories: ['task'],
    });

    const sessionA = await hot.search({
      query: 'task',
      userId: 'default',
      sessionId: 'session-a',
      topK: 10,
    });
    assert.equal(sessionA.memories.some((memory) => /Session A task/.test(memory.text)), true);
    assert.equal(sessionA.memories.some((memory) => /Session B task/.test(memory.text)), false);

    const sessionB = await hot.search({
      query: 'task',
      userId: 'default',
      sessionId: 'session-b',
      topK: 10,
    });
    assert.equal(sessionB.memories.some((memory) => /Session B task/.test(memory.text)), true);
    assert.equal(sessionB.memories.some((memory) => /Session A task/.test(memory.text)), false);

    const shared = await hot.search({
      query: 'sparkling water',
      userId: 'default',
      sessionId: 'session-a',
      topK: 10,
    });
    assert.equal(shared.memories.some((memory) => /sparkling water/.test(memory.text)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
