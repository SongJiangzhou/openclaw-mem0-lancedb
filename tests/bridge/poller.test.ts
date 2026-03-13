import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryMemoryAdapter } from '../../src/bridge/adapter';
import { Mem0Poller } from '../../src/bridge/poller';
import type { PluginConfig } from '../../src/types';

test('Mem0Poller starts and stops without error', () => {
  const cfg: PluginConfig = {
    lancedbPath: '/tmp/test',
    mem0Mode: 'local',
    mem0BaseUrl: 'http://localhost',
    mem0ApiKey: 'test',
    outboxDbPath: '/tmp/test/outbox.json',
    autoRecall: { enabled: false, topK: 5, maxChars: 800, scope: 'all' },
    autoCapture: { enabled: false, scope: 'long-term', requireAssistantReply: true, maxCharsPerMessage: 2000 },
  embedding: { provider: "fake" as const, baseUrl: "", apiKey: "", model: "", dimension: 16 },
  };

  const poller = new Mem0Poller(cfg);
  poller.start(100);
  poller.stop();
  assert.ok(true);
});

test('Mem0Poller syncs fetched memories into the adapter-backed store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'poller-audit-'));
  const cfg: PluginConfig = {
    lancedbPath: join(dir, 'lancedb'),
    mem0Mode: 'local',
    mem0BaseUrl: 'http://localhost',
    mem0ApiKey: 'test',
    outboxDbPath: join(dir, 'outbox.json'),
    autoRecall: { enabled: false, topK: 5, maxChars: 800, scope: 'all' },
    autoCapture: { enabled: false, scope: 'long-term', requireAssistantReply: true, maxCharsPerMessage: 2000 },
    embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
  };

  const originalFetch = globalThis.fetch;
  const adapter = new InMemoryMemoryAdapter();
  globalThis.fetch = (async () => new Response(JSON.stringify({
    results: [
      {
        id: 'mem-1',
        memory: 'User prefers sparkling water over soda.',
        user_id: 'default',
        created_at: '2026-03-12T00:00:00.000Z',
        metadata: {
          scope: 'long-term',
          categories: ['preference'],
          source_kind: 'user_explicit',
          confidence: 0.9,
        },
      },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as any;

  try {
    const poller = new Mem0Poller(cfg, undefined, adapter);
    await poller.poll();
    const rows = await adapter.listMemories({ userId: 'default' });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.memory.text, 'User prefers sparkling water over soda.');
    assert.equal(rows[0]?.memory.user_id, 'default');
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
