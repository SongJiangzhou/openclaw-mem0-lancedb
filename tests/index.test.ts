import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileAuditStore } from '../src/audit/store';
import { MemoryStoreTool } from '../src/tools/store';
import register, { maybeAutoStartLocalMem0, resolveConfig } from '../src/index';

function pendingCapturePath(sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-z0-9]/gi, '_').slice(0, 64);
  return join(tmpdir(), `mem0-cap-${safe}.json`);
}

test('resolveConfig sets embedding migration defaults', async () => {
  const config = resolveConfig();

  assert.equal(config.embeddingMigration?.enabled, true);
  assert.equal(config.embeddingMigration?.intervalMs, 15 * 60 * 1000);
  assert.equal(config.embeddingMigration?.batchSize, 20);
  assert.equal(config.autoRecall.topK, 8);
  assert.equal(config.autoRecall.maxChars, 1400);
});

test('resolveConfig uses the unified memory directory defaults', async () => {
  const config = resolveConfig();

  assert.equal(config.lancedbPath, '~/.openclaw/workspace/data/memory/lancedb');
  assert.equal(config.outboxDbPath, '~/.openclaw/workspace/data/memory/outbox.json');
  assert.equal(config.auditStorePath, '~/.openclaw/workspace/data/memory/audit/memory_records.jsonl');
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
  assert.equal(config.mem0?.autoStartLocal, true);
});

test('maybeAutoStartLocalMem0 does not spawn when local mem0 is already healthy', async () => {
  let spawnCalls = 0;
  const result = await maybeAutoStartLocalMem0(
    resolveConfig({
      mem0: {
        mode: 'local',
        baseUrl: 'http://127.0.0.1:8000',
        apiKey: '',
      },
    } as any),
    { basic() {}, warn() {} } as any,
    {
      fetchFn: (async () => ({ ok: true })) as any,
      spawnFn: (() => {
        spawnCalls += 1;
        throw new Error('should not spawn');
      }) as any,
    },
  );

  assert.equal(result.started, false);
  assert.equal(result.healthy, true);
  assert.equal(spawnCalls, 0);
});

test('maybeAutoStartLocalMem0 spawns local mem0 when healthcheck fails then becomes healthy', async () => {
  let healthChecks = 0;
  let spawnCalls = 0;

  const result = await maybeAutoStartLocalMem0(
    resolveConfig({
      mem0: {
        mode: 'local',
        baseUrl: 'http://127.0.0.1:8000',
        apiKey: '',
      },
    } as any),
    { basic() {}, warn() {} } as any,
    {
      fetchFn: (async () => {
        healthChecks += 1;
        return { ok: healthChecks >= 3 };
      }) as any,
      spawnFn: (() => {
        spawnCalls += 1;
        return { unref() {} };
      }) as any,
      sleep: async () => {},
    },
  );

  assert.equal(result.started, true);
  assert.equal(result.healthy, true);
  assert.equal(spawnCalls, 1);
  assert.equal(healthChecks >= 3, true);
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

test('register logs plugin version to host logger', async () => {
  const messages: string[] = [];

  register({
    registerTool() {},
    logger: {
      info(msg: string) {
        messages.push(msg);
      },
    },
  } as any);

  assert.ok(messages.some((msg) => msg.includes('v0.1.0')));
});

test('register includes plugin version in structured debug log file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-debug-log-'));

  try {
    register({
      pluginConfig: {
        debug: { mode: 'basic', logDir: dir },
      },
      registerTool() {},
    } as any);

    const date = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(dir, `${date}.log`), 'utf-8');
    assert.match(content, /plugin\.register/);
    assert.match(content, /"pluginVersion":"0\.1\.0"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('before_prompt_build injects auto-recall into prependSystemContext without surfacing it to the user', async () => {
  const hooks: Array<{ name: string; handler: Function }> = [];
  const dir = mkdtempSync(join(tmpdir(), 'index-auto-recall-'));

  const store = new MemoryStoreTool({
    lancedbPath: join(dir, 'lancedb'),
    mem0BaseUrl: '',
    mem0ApiKey: '',
    outboxDbPath: join(dir, 'outbox.json'),
    auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
    autoRecall: { enabled: true, topK: 3, maxChars: 300, scope: 'all' as const },
    autoCapture: { enabled: false, scope: 'long-term' as const, requireAssistantReply: true, maxCharsPerMessage: 2000 },
    embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
  });

  await store.execute({
    text: 'User prefers replies in English',
    userId: 'default',
    scope: 'long-term',
    categories: ['preference'],
  });

  try {
    register({
      pluginConfig: {
        lancedbPath: join(dir, 'lancedb'),
        outboxDbPath: join(dir, 'outbox.json'),
        auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
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

    const event = {
      prompt: 'English',
      messages: [
        { role: 'user', content: 'English' },
      ],
    };
    const result = await hook?.handler(
      event,
      {
        agentId: 'main',
        sessionKey: 'test-session',
      },
    );

    assert.equal(typeof result, 'object');
    assert.equal(Array.isArray(event.messages), true);
    assert.equal(String(event.messages[0]?.role || ''), 'user');
    assert.match(String((result as any)?.prependSystemContext || ''), /<recall source="lancedb">/);
    assert.match(String((result as any)?.prependSystemContext || ''), /User prefers replies in English/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

      if (url.endsWith('/v1/event/evt-capture/')) {
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

test('before_prompt_build injects pending capture notification into prependSystemContext without surfacing it to the user', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-auto-capture-note-'));
  const hooks: Array<{ name: string; handler: Function }> = [];
  const originalFetch = global.fetch;

  try {
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/v1/memories/')) {
        return {
          ok: true,
          json: async () => ([
            {
              id: 'mem0-captured-1',
              data: { memory: 'User enjoys a certain food' },
              event: 'ADD',
            },
          ]),
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
        autoRecall: { enabled: true, topK: 3, maxChars: 300, scope: 'all' },
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

    const captureHook = hooks.find((entry) => entry.name === 'agent_end');
    const recallHook = hooks.find((entry) => entry.name === 'before_prompt_build');
    assert.ok(captureHook);
    assert.ok(recallHook);

    await captureHook?.handler(
      {
        messages: [
          { role: 'user', content: 'I enjoy a certain food.' },
          { role: 'assistant', content: 'Noted. You enjoy a certain food.' },
        ],
        success: true,
      },
      { agentId: 'main', sessionKey: 'test-session' },
    );

    const event = {
      prompt: '我喜欢吃什么',
      messages: [{ role: 'user', content: '我喜欢吃什么' }],
    };
    const result = await recallHook?.handler(
      event,
      { agentId: 'main', sessionKey: 'test-session' },
    );

    assert.equal(typeof result, 'object');
    assert.equal(String(event.messages[0]?.role || ''), 'user');
    assert.match(String((result as any)?.prependSystemContext || ''), /<capture via="mem0"/);
    assert.match(String((result as any)?.prependSystemContext || ''), /User enjoys a certain food/);
    assert.throws(() => readFileSync(pendingCapturePath('test-session'), 'utf-8'));
  } finally {
    global.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
    rmSync(pendingCapturePath('test-session'), { force: true });
  }
});

test('auto-capture does not send prior capture notification back to mem0 on the next turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-auto-capture-roundtrip-'));
  const hooks: Array<{ name: string; handler: Function }> = [];
  const originalFetch = global.fetch;
  const capturePayloads: string[] = [];

  try {
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/v1/memories/')) {
        const body = JSON.parse(String(init.body || '{}'));
        capturePayloads.push(body.messages?.map((msg: any) => msg.content).join('\n') || '');
        return {
          ok: true,
          json: async () => ([
            {
              id: `mem0-captured-${capturePayloads.length}`,
              data: { memory: `Memory ${capturePayloads.length}` },
              event: 'ADD',
            },
          ]),
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
        autoRecall: { enabled: true, topK: 3, maxChars: 300, scope: 'all' },
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

    const captureHook = hooks.find((entry) => entry.name === 'agent_end');
    const recallHook = hooks.find((entry) => entry.name === 'before_prompt_build');
    assert.ok(captureHook);
    assert.ok(recallHook);

    await captureHook?.handler(
      {
        messages: [
          { role: 'user', content: 'I enjoy one food.' },
          { role: 'assistant', content: 'Noted. You enjoy one food.' },
        ],
        success: true,
      },
      { agentId: 'main', sessionKey: 'test-session' },
    );

    const beforePromptEvent = {
      prompt: 'hello',
      messages: [{ role: 'user', content: 'hello' }],
    };
    const injected = await recallHook?.handler(
      beforePromptEvent,
      { agentId: 'main', sessionKey: 'test-session' },
    );

    assert.equal(typeof injected, 'object');
    const injectedContext = String((injected as any)?.prependSystemContext || '');

    await captureHook?.handler(
      {
        messages: [
          { role: 'user', content: `${injectedContext}\n\nI enjoy another food.` },
          { role: 'assistant', content: 'Noted. You enjoy another food.' },
        ],
        success: true,
      },
      { agentId: 'main', sessionKey: 'test-session' },
    );

    assert.equal(capturePayloads.length, 2);
    assert.doesNotMatch(capturePayloads[1] || '', /<capture via="mem0"/);
    assert.match(capturePayloads[1] || '', /I enjoy another food\./);
  } finally {
    global.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('before_prompt_build clears pending capture notifications after injecting them into prependSystemContext', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-auto-capture-silent-'));
  const hooks: Array<{ name: string; handler: Function }> = [];
  const sessionKey = 'silent-session';
  const originalFetch = global.fetch;

  try {
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/v1/memories/')) {
        return {
          ok: true,
          json: async () => ([
            {
              id: 'mem0-captured-1',
              data: { memory: 'User likes a dessert brand' },
              event: 'ADD',
            },
          ]),
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
        autoRecall: { enabled: true, topK: 3, maxChars: 300, scope: 'all' },
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

    const captureHook = hooks.find((entry) => entry.name === 'agent_end');
    const recallHook = hooks.find((entry) => entry.name === 'before_prompt_build');
    assert.ok(captureHook);
    assert.ok(recallHook);

    await captureHook?.handler(
      {
        messages: [
          { role: 'user', content: 'I like a dessert brand.' },
          { role: 'assistant', content: 'Noted. You like a dessert brand.' },
        ],
        success: true,
      },
      { agentId: 'main', sessionKey },
    );

    assert.equal(readFileSync(pendingCapturePath(sessionKey), 'utf-8').includes('User likes a dessert brand'), true);

    const event = {
      prompt: 'hello again',
      messages: [{ role: 'user', content: 'hello again' }],
    };
    const result = await recallHook?.handler(
      event,
      { agentId: 'main', sessionKey },
    );

    assert.equal(typeof result, 'object');
    assert.equal(String(event.messages[0]?.role || ''), 'user');
    assert.match(String((result as any)?.prependSystemContext || ''), /<capture via="mem0"/);
    assert.throws(() => readFileSync(pendingCapturePath(sessionKey), 'utf-8'));
  } finally {
    global.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
    rmSync(pendingCapturePath(sessionKey), { force: true });
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

  // User message contains an injected <recall> block with "password" keyword.
  // The actual user turn is clean, so capture should proceed.
  const userMsgWithInjection =
    '<recall>\n- User wants to remember the test password abc123\n</recall>\nPlease reply in English from now on';

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
    assert.ok(!userContent.includes('<recall>'), 'injected block should be stripped from captured text');
    assert.ok(userContent.includes('Please reply in English'), 'actual user intent should be preserved');
  } finally {
    global.fetch = originalFetch;
  }
});

test('auto-capture hook strips host metadata and reply markers before submission', async () => {
  const hooks: Array<{ name: string; handler: Function }> = [];

  register({
    pluginConfig: {
      lancedbPath: join(mkdtempSync(join(tmpdir(), 'oc-test-')), 'lancedb'),
      auditStorePath: join(mkdtempSync(join(tmpdir(), 'oc-test-')), 'audit', 'memory_records.jsonl'),
      outboxDbPath: join(mkdtempSync(join(tmpdir(), 'oc-test-')), 'outbox.json'),
      mem0: { mode: 'remote', baseUrl: 'https://api.mem0.ai', apiKey: 'test-key' },
      embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
      autoCapture: { enabled: true, scope: 'long-term', requireAssistantReply: true, maxCharsPerMessage: 2000 },
    },
    registerTool() {},
    registerHook(name: string, handler: Function) {
      hooks.push({ name, handler });
    },
  } as any);

  const hook = hooks.find((entry) => entry.name === 'agent_end');
  assert.ok(hook);

  let capturedPayload: unknown = null;
  const originalFetch = global.fetch;
  global.fetch = (async (url: string, init: any) => {
    if (url.includes('/v1/memories/') && init?.method === 'POST') {
      capturedPayload = JSON.parse(init.body);
      return { ok: true, json: async () => ({ event_id: 'evt-x' }) };
    }
    return { ok: true, json: async () => ({ status: 'completed', items: [] }) };
  }) as typeof fetch;

  try {
    await hook.handler(
      {
        messages: [
          {
            role: 'user',
            content:
              'Conversation info (untrusted metadata):\n***REMOVED***\n{"message_id":"1"}\n***REMOVED***\n\n我在一家科技公司上班，办公地点在某园区A区',
          },
          {
            role: 'assistant',
            content: '[[reply_to_current]] 记住了。\n\n你在一家科技公司上班，办公地点在某园区A区。',
          },
        ],
        success: true,
      },
      { agentId: 'main', sessionKey: 'test-session' },
    );

    assert.ok(capturedPayload !== null, 'expected capture payload to be submitted');
    const messages = (capturedPayload as any)?.messages as Array<{ role: string; content: string }>;
    assert.deepEqual(messages, [
      { role: 'user', content: '我在一家科技公司上班，办公地点在某园区A区' },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('auto-capture logs empty extraction instead of unavailable when direct response has no memories', async () => {
  const hooks: Array<{ name: string; handler: Function }> = [];
  const logs: string[] = [];
  const originalFetch = global.fetch;

  try {
    global.fetch = (async (url: string, init: any) => {
      if (url.includes('/v1/memories/') && init?.method === 'POST') {
        return { ok: true, json: async () => [] };
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    register({
      pluginConfig: {
        lancedbPath: join(mkdtempSync(join(tmpdir(), 'oc-test-')), 'lancedb'),
        auditStorePath: join(mkdtempSync(join(tmpdir(), 'oc-test-')), 'audit', 'memory_records.jsonl'),
        outboxDbPath: join(mkdtempSync(join(tmpdir(), 'oc-test-')), 'outbox.json'),
        mem0: { mode: 'remote', baseUrl: 'https://api.mem0.ai', apiKey: 'test-key' },
        embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
        autoCapture: { enabled: true, scope: 'long-term', requireAssistantReply: true, maxCharsPerMessage: 2000 },
        debug: { mode: 'basic' as const },
      },
      logger: {
        info(msg: string) {
          logs.push(msg);
        },
        warn(msg: string) {
          logs.push(msg);
        },
        error(msg: string) {
          logs.push(msg);
        },
      },
      registerTool() {},
      registerHook(name: string, handler: Function) {
        hooks.push({ name, handler });
      },
    } as any);

    const hook = hooks.find((entry) => entry.name === 'agent_end');
    assert.ok(hook);

    await hook.handler(
      {
        messages: [
          { role: 'user', content: 'I work at a technology company in office zone A' },
          { role: 'assistant', content: 'Noted. You work at a technology company in office zone A.' },
        ],
        success: true,
      },
      { agentId: 'main', sessionKey: 'test-session' },
    );

    const output = logs.join('\n');
    assert.match(output, /auto_capture\.empty/);
    assert.doesNotMatch(output, /auto_capture\.unavailable/);
  } finally {
    global.fetch = originalFetch;
  }
});
