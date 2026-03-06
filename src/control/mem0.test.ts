import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpMem0Client } from './mem0';
import type { MemoryRecord, PluginConfig } from '../types';

function buildConfig(): PluginConfig {
  return {
    lancedbPath: '/tmp/lancedb',
    mem0BaseUrl: 'https://api.mem0.ai',
    mem0ApiKey: 'test-key',
    outboxDbPath: '/tmp/outbox.json',
    auditStorePath: '/tmp/audit.jsonl',
  };
}

function buildRecord(): MemoryRecord {
  return {
    memory_uid: 'm-1',
    user_id: 'railgun',
    run_id: null,
    scope: 'long-term',
    text: '用户喜欢中文回复',
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

test('http mem0 client returns unavailable when api key is missing', async () => {
  const cfg = { ...buildConfig(), mem0ApiKey: '' };
  const client = new HttpMem0Client(cfg);

  const result = await client.storeMemory(buildRecord());

  assert.equal(result.status, 'unavailable');
});

test('http mem0 client returns submitted result with event id', async () => {
  const fetchStub = (async () => ({
    ok: true,
    json: async () => ({ id: 'mem0-1', event_id: 'evt-1', hash: 'h1' }),
  })) as unknown as typeof fetch;
  const client = new HttpMem0Client(buildConfig(), fetchStub);

  const result = await client.storeMemory(buildRecord());

  assert.equal(result.status, 'submitted');
  if (result.status === 'submitted') {
    assert.equal(result.mem0_id, 'mem0-1');
    assert.equal(result.event_id, 'evt-1');
    assert.equal(result.hash, 'h1');
  }
});

test('http mem0 client confirms completed event', async () => {
  let calls = 0;
  const fetchStub = (async (input: string | URL | Request) => {
    const url = String(input);
    calls += 1;
    if (url.endsWith('/v1/memories/')) {
      return {
        ok: true,
        json: async () => ({ id: 'mem0-1', event_id: 'evt-ok', hash: 'h1' }),
      };
    }
    return {
      ok: true,
      json: async () => ({ status: 'completed' }),
    };
  }) as unknown as typeof fetch;
  const client = new HttpMem0Client(buildConfig(), fetchStub);

  const submitted = await client.storeMemory(buildRecord());
  assert.equal(submitted.status, 'submitted');
  if (submitted.status !== 'submitted') {
    return;
  }

  const confirmed = await client.waitForEvent(submitted.event_id || '', { attempts: 1, delayMs: 0 });

  assert.equal(confirmed.status, 'confirmed');
  assert.ok(calls >= 2);
});

test('http mem0 client times out when event confirmation does not arrive', async () => {
  const fetchStub = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/v1/memories/')) {
      return {
        ok: true,
        json: async () => ({ id: 'mem0-1', event_id: 'evt-timeout', hash: 'h1' }),
      };
    }
    return {
      ok: true,
      json: async () => ({ status: 'pending' }),
    };
  }) as unknown as typeof fetch;
  const client = new HttpMem0Client(buildConfig(), fetchStub);

  const submitted = await client.storeMemory(buildRecord());
  assert.equal(submitted.status, 'submitted');
  if (submitted.status !== 'submitted') {
    return;
  }

  const confirmed = await client.waitForEvent(submitted.event_id || '', { attempts: 2, delayMs: 0 });

  assert.equal(confirmed.status, 'timeout');
});
