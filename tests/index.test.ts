import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FileAuditStore } from '../src/audit/store';
import { MemoryStoreTool } from '../src/tools/store';
import register, { maybeAutoStartLocalMem0, resolveConfig } from '../src/index';

const LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function pendingCapturePath(sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-z0-9]/gi, '_').slice(0, 64);
  return join(tmpdir(), `mem0-cap-${safe}.json`);
}

test('resolveConfig sets embedding migration defaults', async () => {
  const config = resolveConfig();

  assert.equal(config.embeddingMigration?.enabled, true);
  assert.equal(config.embeddingMigration?.intervalMs, 15 * 60 * 1000);
  assert.equal(config.embeddingMigration?.batchSize, 20);
  assert.equal(config.memoryConsolidation?.enabled, true);
  assert.equal(config.memoryConsolidation?.intervalMs, 6 * 60 * 60 * 1000);
  assert.equal(config.memoryConsolidation?.batchSize, 50);
  assert.equal(config.mem0Mode, 'local');
  assert.equal(config.mem0BaseUrl, 'http://127.0.0.1:8000');
  assert.equal(config.autoRecall.topK, 5);
  assert.equal(config.autoRecall.maxChars, 1400);
  assert.equal(config.autoCapture.enabled, true);
  assert.equal(config.autoCapture.scope, 'long-term');
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

test('resolveConfig respects memory consolidation overrides', async () => {
  const config = resolveConfig({
    memoryConsolidation: {
      enabled: false,
      intervalMs: 120_000,
      batchSize: 10,
    },
  } as any);

  assert.equal(config.memoryConsolidation?.enabled, false);
  assert.equal(config.memoryConsolidation?.intervalMs, 120_000);
  assert.equal(config.memoryConsolidation?.batchSize, 10);
});

test('resolveConfig maps nested mem0 config into explicit runtime mode', async () => {
  const config = resolveConfig({
    mem0: {
      mode: 'local',
      baseUrl: 'http://127.0.0.1:8000',
      apiKey: '',
      llm: {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'deepseek-key',
        model: 'deepseek-chat',
      },
    },
  } as any);

  assert.equal(config.mem0Mode, 'local');
  assert.equal(config.mem0BaseUrl, 'http://127.0.0.1:8000');
  assert.equal(config.mem0ApiKey, '');
  assert.equal(config.mem0?.autoStartLocal, true);
  assert.equal(config.mem0?.llm?.provider, 'deepseek');
  assert.equal(config.mem0?.llm?.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.mem0?.llm?.apiKey, 'deepseek-key');
  assert.equal(config.mem0?.llm?.model, 'deepseek-chat');
});

test('resolveConfig maps voyage embedding from OpenClaw memorySearch config', async () => {
  const config = resolveConfig(undefined, {
    agents: {
      defaults: {
        memorySearch: {
          enabled: true,
          provider: 'voyage',
          model: 'voyage-3.5-lite',
          remote: {
            apiKey: 'voyage-test-key',
            baseUrl: 'https://api.voyageai.com/v1',
          },
        },
      },
    },
  });

  assert.equal(config.embedding.provider, 'voyage');
  assert.equal(config.embedding.apiKey, 'voyage-test-key');
  assert.equal(config.embedding.baseUrl, 'https://api.voyageai.com/v1');
  assert.equal(config.embedding.model, 'voyage-3.5-lite');
});

test('resolveConfig sets autoRecall reranker defaults and overrides', async () => {
  const defaults = resolveConfig();
  assert.equal(defaults.autoRecall.reranker?.provider, 'local');
  assert.equal(defaults.autoRecall.reranker?.baseUrl, 'https://api.voyageai.com/v1');
  assert.equal(defaults.autoRecall.reranker?.apiKey, '');
  assert.equal(defaults.autoRecall.reranker?.model, 'rerank-2.5-lite');

  const config = resolveConfig({
    autoRecall: {
      enabled: true,
      topK: 5,
      maxChars: 600,
      scope: 'all',
      reranker: {
        provider: 'voyage',
        apiKey: 'rerank-key',
        baseUrl: 'https://custom.voyage.test/v1',
        model: 'rerank-2.5',
      },
    },
  } as any);

  assert.equal(config.autoRecall.reranker?.provider, 'voyage');
  assert.equal(config.autoRecall.reranker?.apiKey, 'rerank-key');
  assert.equal(config.autoRecall.reranker?.baseUrl, 'https://custom.voyage.test/v1');
  assert.equal(config.autoRecall.reranker?.model, 'rerank-2.5');
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

  assert.equal(config.mem0Mode, 'local');
  assert.equal(config.mem0BaseUrl, 'http://127.0.0.1:8000');
  assert.equal(config.mem0ApiKey, '');
});

test('resolveConfig sets debug defaults', async () => {
  const config = resolveConfig();

  assert.equal(config.debug?.mode, 'off');
  assert.equal('logDir' in (config.debug || {}), false);
});

test('resolveConfig does not expose debug logDir when debug mode is enabled', async () => {
  const config = resolveConfig({
    debug: {
      mode: 'debug',
    },
  } as any);

  assert.equal(config.debug?.mode, 'debug');
  assert.equal('logDir' in (config.debug || {}), false);
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

test('register exposes lifecycle hooks as the primary memory interface', async () => {
  const hooks: Array<{ event: string; name: string }> = [];
  const tools: Array<{ name: string; description: string }> = [];

  register({
    pluginConfig: {
      autoRecall: { enabled: true, topK: 3, maxChars: 300, scope: 'all' },
      autoCapture: { enabled: true, scope: 'long-term', requireAssistantReply: true, maxCharsPerMessage: 2000 },
    },
    registerTool(tool: any) {
      tools.push({ name: String(tool.name || ''), description: String(tool.description || '') });
    },
    registerHook(event: string, _handler: Function, opts?: any) {
      hooks.push({ event, name: String(opts?.name || '') });
    },
  } as any);

  assert.ok(hooks.some((hook) => hook.event === 'before_prompt_build' && hook.name === 'mem0-auto-recall'));
  assert.ok(hooks.some((hook) => hook.event === 'agent_end' && hook.name === 'mem0-auto-capture'));
  assert.match(tools.find((tool) => tool.name === 'memory_search')?.description || '', /operator|debug|admin/i);
  assert.match(tools.find((tool) => tool.name === 'memorySearch')?.description || '', /operator|debug|admin/i);
  assert.match(tools.find((tool) => tool.name === 'memoryStore')?.description || '', /manual|operator|admin/i);
  assert.match(tools.find((tool) => tool.name === 'memory_get')?.description || '', /diagnostic|debug|admin/i);
});

test('register does not start promotion worker by default', async () => {
  const messages: string[] = [];

  register({
    pluginConfig: {
      debug: { mode: 'debug' },
    },
    registerTool() {},
    logger: {
      info(msg: string) {
        messages.push(msg);
      },
    },
  } as any);

  assert.ok(messages.every((msg) => !msg.includes('"event":"plugin.promotion_worker_started"')));
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
  assert.ok(messages.some((msg) => /hook-first memory sidecar/i.test(msg)));
});

test('register does not include debugLogDir in structured debug output', async () => {
  const messages: string[] = [];

  register({
    pluginConfig: {
      debug: { mode: 'debug' },
    },
    registerTool() {},
    logger: {
      info(msg: string) {
        messages.push(msg);
      },
    },
  } as any);

  const pluginRegisterLog = messages.find((msg) => msg.includes('"event":"plugin.register"')) || '';
  assert.ok(pluginRegisterLog);
  assert.doesNotMatch(pluginRegisterLog, /debugLogDir/);
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

test('before_prompt_build keeps recall hidden from user output in debug mode', async () => {
  const hooks: Array<{ name: string; handler: Function }> = [];
  const dir = mkdtempSync(join(tmpdir(), 'index-auto-recall-visible-'));

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
    text: 'User prefers concise replies',
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
        debug: { mode: 'debug' as const },
      },
      registerTool() {},
      on(name: string, handler: Function) {
        hooks.push({ name, handler });
      },
    } as any);

    const hook = hooks.find((entry) => entry.name === 'before_prompt_build');
    assert.ok(hook);

    const result = await hook?.handler(
      {
        prompt: 'How should you reply?',
        messages: [{ role: 'user', content: 'How should you reply?' }],
      },
      { agentId: 'main', sessionKey: 'test-session' },
    );

    assert.match(String((result as any)?.prependSystemContext || ''), /<recall source="lancedb">/);
    assert.equal((result as any)?.prependContext, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('before_prompt_build logs empty recall emission in debug mode when no memories are found', async () => {
  const hooks: Array<{ name: string; handler: Function }> = [];
  const dir = mkdtempSync(join(tmpdir(), 'index-auto-recall-empty-visible-'));
  const debugEvents: string[] = [];

  try {
    register({
      pluginConfig: {
        lancedbPath: join(dir, 'lancedb'),
        outboxDbPath: join(dir, 'outbox.json'),
        auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
        embedding: { provider: 'fake' as const, baseUrl: '', apiKey: '', model: '', dimension: 16 },
        autoRecall: { enabled: true, topK: 3, maxChars: 300, scope: 'all' },
        debug: { mode: 'debug' as const },
      },
      logger: {
        info(message: string) {
          debugEvents.push(message);
        },
      },
      registerTool() {},
      on(name: string, handler: Function) {
        hooks.push({ name, handler });
      },
    } as any);

    const hook = hooks.find((entry) => entry.name === 'before_prompt_build');
    assert.ok(hook);

    const result = await hook?.handler(
      {
        prompt: 'What do I prefer to drink?',
        messages: [{ role: 'user', content: 'What do I prefer to drink?' }],
      },
      { agentId: 'main', sessionKey: 'test-session' },
    );

    assert.equal(result, null);
    assert.ok(debugEvents.some((line) => line.includes('"event":"auto_recall.debug_block_emitted"')));
    assert.ok(debugEvents.some((line) => line.includes('"source":"none"')));
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
    assert.equal(records[0]?.scope, 'long-term');
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
      prompt: 'What foods do I like?',
      messages: [{ role: 'user', content: 'What foods do I like?' }],
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

test('hook-first flow carries pending captured memory into the next turn without tool calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-hook-first-flow-'));
  const hooks: Array<{ name: string; handler: Function }> = [];
  const originalFetch = global.fetch;
  let toolExecutionCount = 0;

  try {
    global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/v1/memories/')) {
        return {
          ok: true,
          json: async () => ([
            {
              id: 'mem0-captured-hook-flow',
              data: { memory: 'Prefers hook-driven memory' },
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
      registerTool(tool: any) {
        const originalExecute = tool.execute;
        tool.execute = async (...args: any[]) => {
          toolExecutionCount += 1;
          return originalExecute(...args);
        };
      },
      registerHook(name: string, handler: Function) {
        hooks.push({ name, handler });
      },
    } as any);

    const captureHook = hooks.find((entry) => entry.name === 'agent_end');
    const recallHook = hooks.find((entry) => entry.name === 'before_prompt_build');
    assert.ok(captureHook);
    assert.ok(recallHook);

    const captureResult = await captureHook?.handler(
      {
        messages: [
          { role: 'user', content: 'Please remember that I prefer hook-driven memory.' },
          { role: 'assistant', content: 'Noted. You prefer hook-driven memory.' },
        ],
        success: true,
      },
      { agentId: 'main', sessionKey: 'hook-first-session' },
    );

    assert.equal(captureResult?.synced?.synced, 1);

    const recallResult = await recallHook?.handler(
      {
        prompt: 'How should the memory system work?',
        messages: [{ role: 'user', content: 'How should the memory system work?' }],
      },
      { agentId: 'main', sessionKey: 'hook-first-session' },
    );

    assert.equal(toolExecutionCount, 0);
    assert.match(String((recallResult as any)?.prependSystemContext || ''), /Prefers hook-driven memory/);
    assert.match(String((recallResult as any)?.prependSystemContext || ''), /<capture via="mem0"/);
  } finally {
    global.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
    rmSync(pendingCapturePath('hook-first-session'), { force: true });
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

test('auto-capture hook strips visible debug recall blocks before sanitization', async () => {
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

  const userMsgWithInjection =
    '<debug-recall source="lancedb">\n- [long-term] User prefers concise replies\n</debug-recall>\nPlease keep answers short.';

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
          { role: 'user', content: userMsgWithInjection },
          { role: 'assistant', content: 'Understood.' },
        ],
        success: true,
      },
      { agentId: 'main', sessionKey: 'test-session' },
    );

    assert.ok(capturedPayload !== null, 'expected capture payload to be submitted');
    const messages = (capturedPayload as any)?.messages as Array<{ role: string; content: string }>;
    const userContent = messages?.find((m) => m.role === 'user')?.content ?? '';
    assert.ok(!userContent.includes('<debug-recall>'), 'visible debug block should be stripped from captured text');
    assert.ok(userContent.includes('Please keep answers short.'), 'actual user intent should be preserved');
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
              'Conversation info (untrusted metadata):\n```json\n{"message_id":"1"}\n```\n\nI work at a technology company in office zone A.',
          },
          {
            role: 'assistant',
            content: '[[reply_to_current]] Noted.\n\nYou work at a technology company in office zone A.',
          },
        ],
        success: true,
      },
      { agentId: 'main', sessionKey: 'test-session' },
    );

    assert.ok(capturedPayload !== null, 'expected capture payload to be submitted');
    const messages = (capturedPayload as any)?.messages as Array<{ role: string; content: string }>;
    assert.deepEqual(messages, [
      { role: 'user', content: 'I work at a technology company in office zone A.' },
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
        debug: { mode: 'debug' as const },
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
