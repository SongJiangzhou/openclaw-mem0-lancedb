import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStoreTool } from '../../src/tools/store';
import { MemorySearchTool } from '../../src/tools/search';

test('store/search works with local fallback when mem0ApiKey is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem0-lancedb-test-'));
  try {
    const auditStorePath = join(dir, 'audit', 'memory_records.jsonl');
    const cfg = {
      lancedbPath: dir,
      mem0BaseUrl: 'http://127.0.0.1:9',
      mem0ApiKey: '',
      outboxDbPath: join(dir, 'outbox.json'),
      auditStorePath,
      autoRecall: { enabled: false, topK: 5, maxChars: 800, scope: 'all' as const },
      autoCapture: { enabled: false, scope: 'long-term' as const, requireAssistantReply: true, maxCharsPerMessage: 2000 },
  embedding: { provider: "fake" as const, baseUrl: "", apiKey: "", model: "", dimension: 16 },
    };

    const store = new MemoryStoreTool(cfg);
    const search = new MemorySearchTool(cfg);

    const write = await store.execute({
      text: 'User preference: reply in English',
      userId: 'user-1',
      scope: 'long-term',
      categories: ['preference'],
    });

    assert.equal(write.success, true);
    assert.equal(write.syncStatus, 'partial');

    const result = await search.execute({
      query: 'reply in English',
      userId: 'user-1',
      topK: 3,
    });

    assert.equal(result.source, 'lancedb');
    assert.ok(result.memories.length >= 1);
    assert.match(result.memories[0].text, /reply in English/);
    assert.match(readFileSync(auditStorePath, 'utf-8'), /reply in English/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('search returns local results when mem0 fallback fails after partial local success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem0-lancedb-partial-fallback-'));
  const originalWarn = console.warn;
  const originalError = console.error;
  const logs: string[] = [];

  console.warn = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    const auditStorePath = join(dir, 'audit', 'memory_records.jsonl');
    const cfg = {
      lancedbPath: dir,
      mem0BaseUrl: 'http://127.0.0.1:8000',
      mem0ApiKey: '',
      mem0Mode: 'local' as const,
      outboxDbPath: join(dir, 'outbox.json'),
      auditStorePath,
      autoRecall: { enabled: false, topK: 5, maxChars: 800, scope: 'all' as const },
      autoCapture: { enabled: false, scope: 'long-term' as const, requireAssistantReply: true, maxCharsPerMessage: 2000 },
      embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
    };

    const store = new MemoryStoreTool(cfg);
    const search = new MemorySearchTool(cfg);
    const originalSearchMem0Enhanced = (search as any).searchMem0Enhanced;
    (search as any).searchMem0Enhanced = async () => {
      throw new Error('mem0 exploded');
    };

    await store.execute({
      text: 'User likes sparkling water.',
      userId: 'user-2',
      scope: 'long-term',
      categories: ['preference'],
    });

    const result = await search.execute({
      query: 'sparkling water',
      userId: 'user-2',
      topK: 5,
    });

    assert.equal(result.source, 'lancedb');
    assert.equal(result.memories.length, 1);
    assert.match(result.memories[0].text, /sparkling water/);
    assert.ok(logs.some((line) => line.includes('memory_search.mem0_fallback_failed')));

    (search as any).searchMem0Enhanced = originalSearchMem0Enhanced;
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    rmSync(dir, { recursive: true, force: true });
  }
});
