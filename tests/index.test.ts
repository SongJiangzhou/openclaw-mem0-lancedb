import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileAuditStore } from '../src/audit/store';
import register, { resolveConfig } from '../src/index';

test('resolveConfig sets embedding migration defaults', async () => {
  const config = resolveConfig();

  assert.equal(config.embeddingMigration?.enabled, true);
  assert.equal(config.embeddingMigration?.intervalMs, 15 * 60 * 1000);
  assert.equal(config.embeddingMigration?.batchSize, 20);
});

test('resolveConfig respects embedding migration overrides', async () => {
  const config = resolveConfig({
    embeddingMigration: {
      enabled: false,
      intervalMs: 30_000,
      batchSize: 5,
    },
  } as any);

  assert.equal(config.embeddingMigration?.enabled, false);
  assert.equal(config.embeddingMigration?.intervalMs, 30_000);
  assert.equal(config.embeddingMigration?.batchSize, 5);
});

test('resolveConfig maps nested mem0 config into explicit runtime mode', async () => {
  const config = resolveConfig({
    mem0: {
      mode: 'local',
      baseUrl: 'http://127.0.0.1:8000',
      apiKey: '',
    },
  } as any);

  assert.equal(config.mem0Mode, 'local');
  assert.equal(config.mem0BaseUrl, 'http://127.0.0.1:8000');
  assert.equal(config.mem0ApiKey, '');
});

test('register installs auto-recall hook when enabled and hook api exists', async () => {
  const hooks: Array<{ name: string; handler: Function }> = [];
  const tools: string[] = [];

  register({
    pluginConfig: {
      autoRecall: { enabled: true, topK: 3, maxChars: 300, scope: 'all' },
    },
    registerTool(tool: any) {
      tools.push(tool.name);
    },
    registerHook(name: string, handler: Function) {
      hooks.push({ name, handler });
    },
  } as any);

  assert.ok(tools.includes('memory_search'));
  assert.ok(hooks.some((hook) => hook.name === 'agent_start'));
});

test('register does not throw when auto-recall is enabled but no hook api exists', async () => {
  assert.doesNotThrow(() => {
    register({
      pluginConfig: {
        autoRecall: { enabled: true, topK: 3, maxChars: 300, scope: 'all' },
      },
      registerTool() {},
    } as any);
  });
});

test('register installs auto-capture hook when enabled and hook api exists', async () => {
  const hooks: Array<{ name: string; handler: Function }> = [];

  register({
    pluginConfig: {
      embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
      autoCapture: {
        enabled: true,
        scope: 'long-term',
        requireAssistantReply: true,
        maxCharsPerMessage: 2000,
      },
    },
    registerTool() {},
    registerHook(name: string, handler: Function) {
      hooks.push({ name, handler });
    },
  } as any);

  assert.ok(hooks.some((hook) => hook.name === 'agent_end'));
});

test('auto-capture hook syncs extracted memories into local storage after mem0 confirmation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-auto-capture-'));
  const hooks: Array<{ name: string; handler: Function }> = [];
  const originalFetch = global.fetch;

  try {
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);

      if (init?.method === 'POST' && url.endsWith('/v1/memories/')) {
        return {
          ok: true,
          json: async () => ({ id: 'capture-1', event_id: 'evt-capture', hash: 'h1' }),
        };
      }

      if (url.endsWith('/v1/events/evt-capture')) {
        return {
          ok: true,
          json: async () => ({ status: 'completed' }),
        };
      }

      if (url.includes('/v1/memories/?')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'mem0-captured-1',
                memory: 'User prefers replies in English',
                categories: ['preference'],
                hash: 'hash-1',
              },
            ],
          }),
        };
      }

      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    register({
      pluginConfig: {
        lancedbPath: join(dir, 'lancedb'),
        auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
        outboxDbPath: join(dir, 'outbox.json'),
        mem0BaseUrl: 'https://api.mem0.ai',
        mem0ApiKey: 'test-key',
        embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
        autoCapture: {
          enabled: true,
          scope: 'long-term',
          requireAssistantReply: true,
          maxCharsPerMessage: 2000,
        },
      },
      registerTool() {},
      registerHook(name: string, handler: Function) {
        hooks.push({ name, handler });
      },
    } as any);

    const hook = hooks.find((entry) => entry.name === 'agent_end');
    assert.ok(hook);

    const result = await hook?.handler({
      userId: 'user-1',
      runId: 'run-1',
      latestUserMessage: 'Please reply in English from now on',
      latestAssistantMessage: 'Understood. I will reply in English from now on.',
    });

    assert.equal(result?.confirmation?.status, 'confirmed');
    assert.equal(result?.synced?.synced, 1);

    const auditStore = new FileAuditStore(join(dir, 'audit', 'memory_records.jsonl'));
    const records = await auditStore.readAll();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.text, 'User prefers replies in English');
    assert.equal(records[0]?.mem0?.event_id, 'evt-capture');
  } finally {
    global.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
