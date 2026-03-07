import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileAuditStore } from './audit/store';
import register from './index';

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
                memory: '用户偏好使用中文回复',
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
      userId: 'railgun',
      runId: 'run-1',
      latestUserMessage: '用户要求以后都用中文回复',
      latestAssistantMessage: '好的，之后我会使用中文回复。',
    });

    assert.equal(result?.confirmation?.status, 'confirmed');
    assert.equal(result?.synced?.synced, 1);

    const auditStore = new FileAuditStore(join(dir, 'audit', 'memory_records.jsonl'));
    const records = await auditStore.readAll();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.text, '用户偏好使用中文回复');
    assert.equal(records[0]?.mem0?.event_id, 'evt-capture');
  } finally {
    global.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
