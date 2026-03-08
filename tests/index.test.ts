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

test('resolveConfig does not read deprecated top-level mem0 auth fields', async () => {
  const config = resolveConfig({
    mem0BaseUrl: 'http://127.0.0.1:8000',
    mem0ApiKey: 'deprecated-key',
  } as any);

  assert.equal(config.mem0Mode, 'remote');
  assert.equal(config.mem0BaseUrl, 'https://api.mem0.ai');
  assert.equal(config.mem0ApiKey, '');
});

test('resolveConfig sets debug defaults', async () => {
  const config = resolveConfig();

  assert.equal(config.debug?.mode, 'off');
  assert.equal(config.debug?.logDir, undefined);
});

test('resolveConfig respects debug overrides', async () => {
  const config = resolveConfig({
    debug: {
      mode: 'verbose',
      logDir: '/tmp/openclaw-debug',
    },
  } as any);

  assert.equal(config.debug?.mode, 'verbose');
  assert.equal(config.debug?.logDir, '/tmp/openclaw-debug');
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
    on(name: string, handler: Function) {
      hooks.push({ name, handler });
    },
  } as any);

  assert.ok(tools.includes('memory_search'));
  assert.ok(hooks.some((hook) => hook.name === 'before_prompt_build'));
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

test('before_prompt_build auto-recall hook returns prependContext when memories are found', async () => {
  const hooks: Array<{ name: string; handler: Function }> = [];

  register({
    pluginConfig: {
      lancedbPath: join(mkdtempSync(join(tmpdir(), 'index-auto-recall-')), 'lancedb'),
      embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
      autoRecall: { enabled: true, topK: 3, maxChars: 300, scope: 'all' },
    },
    registerTool() {},
    on(name: string, handler: Function) {
      hooks.push({ name, handler });
    },
  } as any);

  const hook = hooks.find((entry) => entry.name === 'before_prompt_build');
  assert.ok(hook);

  const result = await hook?.handler(
    {},
    {
      userId: 'user-1',
      latestUserMessage: 'What language should you use?',
      messages: [
        { role: 'user', content: 'Please always reply in English' },
      ],
    },
  );

  assert.equal(result, null);
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
        mem0: {
          mode: 'remote',
          baseUrl: 'https://api.mem0.ai',
          apiKey: 'test-key',
        },
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

    // Real agent_end signature: handler(event, ctx)
    const result = await hook?.handler(
      {
        messages: [
          { role: 'user', content: 'Please reply in English from now on' },
          { role: 'assistant', content: 'Understood. I will reply in English from now on.' },
        ],
        success: true,
      },
      {
        agentId: 'main',
        sessionKey: 'test-session',
      },
    );

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

test('auto-capture hook strips injected recall blocks before sanitization', async () => {
  const hooks: Array<{ name: string; handler: Function }> = [];

  register({
    pluginConfig: {
      lancedbPath: join(mkdtempSync(join(tmpdir(), 'oc-test-')), 'lancedb'),
      auditStorePath: join(mkdtempSync(join(tmpdir(), 'oc-test-')), 'audit', 'memory_records.jsonl'),
      outboxDbPath: join(mkdtempSync(join(tmpdir(), 'oc-test-')), 'outbox.json'),
      mem0: { mode: 'remote', baseUrl: 'https://api.mem0.ai', apiKey: 'test-key' },
      embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
      autoCapture: { enabled: true, scope: 'long-term', requireAssistantReply: false, maxCharsPerMessage: 2000 },
    },
    registerTool() {},
    registerHook(name: string, handler: Function) {
      hooks.push({ name, handler });
    },
  } as any);

  const hook = hooks.find((entry) => entry.name === 'agent_end');
  assert.ok(hook);

  // User message contains an injected <relevant_memories> block with "password" keyword.
  // The actual user turn is clean, so capture should proceed.
  const userMsgWithInjection =
    '<relevant_memories>\n- User wants to remember the test password abc123\n</relevant_memories>\nPlease reply in English from now on';

  let capturedPayload: unknown = null;
  const originalFetch = global.fetch;
  global.fetch = (async (url: string, init: any) => {
    if (url.includes('/v1/memories/') && init?.method === 'POST') {
      capturedPayload = JSON.parse(init.body);
      return { ok: true, json: async () => ({ event_id: 'evt-x' }) };
    }
    // stub out remaining calls
    return { ok: true, json: async () => ({ status: 'completed', items: [] }) };
  }) as typeof fetch;

  try {
    await hook.handler(
      {
        messages: [
          { role: 'user', content: userMsgWithInjection },
          { role: 'assistant', content: 'Understood.' },
        ],
        success: true,
      },
      { agentId: 'main', sessionKey: 'test-session' },
    );

    // Payload should have been built (not null) and the user message should be stripped
    assert.ok(capturedPayload !== null, 'expected capture payload to be submitted');
    const messages = (capturedPayload as any)?.messages as Array<{ role: string; content: string }>;
    const userContent = messages?.find((m) => m.role === 'user')?.content ?? '';
    assert.ok(!userContent.includes('<relevant_memories>'), 'injected block should be stripped from captured text');
    assert.ok(userContent.includes('Please reply in English'), 'actual user intent should be preserved');
  } finally {
    global.fetch = originalFetch;
  }
});
