import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileAuditStore } from './audit/store';
import { LanceDbMemoryAdapter } from './bridge/adapter';
import { MemorySearchTool } from './tools/search';
import { MemoryStoreTool } from './tools/store';
import { MemoryGetTool } from './tools/get';
import { buildAutoCapturePayload, stripInjectedArtifacts } from './capture/auto';
import { syncCapturedMemories } from './capture/sync';
import { HttpMem0Client } from './control/mem0';
import { runAutoRecall } from './recall/auto';
import { Mem0Poller } from './bridge/poller';
import { EmbeddingMigrationWorker } from './hot/migration-worker';
import { PluginDebugLogger, summarizeText } from './debug/logger';
import type { PluginConfig } from './types';

function textResult(summary: string, details: any) {
  return {
    content: [{ type: 'text', text: summary }],
    details,
  };
}

type OpenClawApi = {
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  config?: any;
  pluginConfig?: Partial<PluginConfig>;
  registerTool: (tool: any, options?: any) => void;
  registerHook?: (events: string | string[], handler: (...args: any[]) => any, opts?: any) => void;
  on?: (event: string, handler: (...args: any[]) => any, opts?: any) => void;
};

const PLUGIN_VERSION = readPluginVersion();

export function resolveConfig(raw?: Partial<PluginConfig>, apiConfig?: any): PluginConfig {
  const mem0 = resolveMem0Config(raw);

  return {
    lancedbPath: raw?.lancedbPath || '~/.openclaw/workspace/data/memory_lancedb',
    mem0,
    mem0Mode: mem0.mode,
    mem0BaseUrl: mem0.baseUrl,
    mem0ApiKey: mem0.apiKey,
    outboxDbPath: raw?.outboxDbPath || '~/.openclaw/workspace/data/outbox.json',
    auditStorePath: raw?.auditStorePath || '~/.openclaw/workspace/data/memory_audit/memory_records.jsonl',
    autoRecall: {
      enabled: raw?.autoRecall?.enabled ?? true,
      topK: raw?.autoRecall?.topK || 8,
      maxChars: raw?.autoRecall?.maxChars || 1400,
      scope: raw?.autoRecall?.scope || 'all',
    },
    autoCapture: {
      enabled: raw?.autoCapture?.enabled || false,
      scope: raw?.autoCapture?.scope || 'long-term',
      requireAssistantReply: raw?.autoCapture?.requireAssistantReply ?? true,
      maxCharsPerMessage: raw?.autoCapture?.maxCharsPerMessage || 2000,
    },
    embedding: resolveEmbeddingConfig(raw, apiConfig),
    embeddingMigration: {
      enabled: raw?.embeddingMigration?.enabled ?? true,
      intervalMs: raw?.embeddingMigration?.intervalMs || 15 * 60 * 1000,
      batchSize: raw?.embeddingMigration?.batchSize || 20,
    },
    debug: {
      mode: raw?.debug?.mode || 'off',
      logDir: raw?.debug?.logDir || undefined,
    },
  };
}

function resolveMem0Config(raw?: Partial<PluginConfig>): NonNullable<PluginConfig['mem0']> {
  const explicitBaseUrl = raw?.mem0?.baseUrl || 'https://api.mem0.ai';
  const explicitApiKey = raw?.mem0?.apiKey || '';
  const explicitMode = raw?.mem0?.mode || 'remote';

  return {
    mode: explicitMode,
    baseUrl: explicitBaseUrl,
    apiKey: explicitApiKey,
  };
}

function resolveEmbeddingConfig(raw?: Partial<PluginConfig>, apiConfig?: any): PluginConfig['embedding'] {
  // 如果显式配置了 embedding（包括 fake），直接使用
  if (raw?.embedding && raw.embedding.provider) {
    return raw.embedding;
  }

  const ms = apiConfig?.agents?.defaults?.memorySearch;
  if (ms?.enabled && ms?.provider && ['openai', 'gemini', 'ollama'].includes(ms.provider)) {
    const p = ms.provider;
    let fallbackModel = 'text-embedding-3-small';
    let defaultDim = 1536;
    let defaultUrl = 'https://api.openai.com';

    if (p === 'gemini') {
      fallbackModel = 'gemini-embedding-001';
      defaultDim = 3072;
      defaultUrl = 'https://generativelanguage.googleapis.com/v1beta';
    } else if (p === 'ollama') {
      fallbackModel = 'nomic-embed-text';
      defaultDim = 768;
      defaultUrl = 'http://127.0.0.1:11434';
    }

    return {
      provider: p as any,
      baseUrl: ms.remote?.baseUrl || defaultUrl,
      apiKey: ms.remote?.apiKey || '',
      model: ms.model || fallbackModel,
      dimension: defaultDim,
    };
  }

  return { provider: 'fake', baseUrl: '', apiKey: '', model: '', dimension: 16 };
}

// OpenClaw 插件入口必须是函数或带 register() 的对象，不能直接导出 class。
export default function register(api: OpenClawApi) {
  const cfg = resolveConfig(api.pluginConfig, api.config);
  const debug = new PluginDebugLogger(cfg.debug, api.logger);
  const customSearch = new MemorySearchTool(cfg);
  const customStore = new MemoryStoreTool(cfg, debug);
  const customGet = new MemoryGetTool(cfg);

  debug.basic('plugin.register', {
    pluginVersion: PLUGIN_VERSION,
    mem0Mode: cfg.mem0Mode,
    mem0BaseUrl: cfg.mem0BaseUrl,
    autoRecallEnabled: cfg.autoRecall.enabled,
    autoCaptureEnabled: cfg.autoCapture.enabled,
    embeddingDimension: cfg.embedding.dimension,
    embeddingMigrationEnabled: cfg.embeddingMigration?.enabled ?? true,
    debugMode: cfg.debug?.mode || 'off',
    debugLogDir: cfg.debug?.logDir,
  });

  const poller = new Mem0Poller(cfg, debug);
  poller.start();
  debug.basic('plugin.poller_started', {});
  const migrationWorker = new EmbeddingMigrationWorker(cfg, debug);
  migrationWorker.start();
  debug.basic('plugin.migration_worker_started', {});

  // memory slot 主工具：完全走新机制（不再桥接 memory-core）
  api.registerTool({
    name: 'memory_search',
    description: 'Search migrated memories from local LanceDB-side store with optional Mem0 fallback',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        userId: { type: 'string', description: 'User identifier', default: 'default' },
        topK: { type: 'number', default: 5, description: 'Number of results' },
        filters: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['long-term', 'session'] },
            status: { type: 'string', enum: ['active', 'superseded', 'deleted'] },
            categories: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      required: ['query'],
    },
    async execute(_id: string, params: any) {
      const result = await customSearch.execute({ userId: 'default', ...params });
      const summary = result.memories
        .map((m: any, i: number) => `[${i + 1}] (${m.scope || 'long-term'}) ${m.text}`)
        .join('\n');
      const header = `memory_search: source=${result.source}, hits=${result.memories.length}`;
      return textResult(result.memories.length > 0 ? `${header}\n${summary}` : header, result);
    },
  });

  api.registerTool({
    name: 'memory_get',
    description: 'Read snippet from a migrated memory source path',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path, e.g. MEMORY.md' },
        from: { type: 'number', description: '1-based start line' },
        lines: { type: 'number', description: 'Number of lines' },
      },
      required: ['path'],
    },
    async execute(_id: string, params: any) {
      const result = await customGet.execute(params);
      return textResult(`memory_get: ${result.path} lines ${result.from}-${result.from + result.lines - 1}`, result);
    },
  });

  // 自定义增强检索（LanceDB + Mem0 fallback）
  api.registerTool(
    {
      name: 'memorySearch',
      description: 'Search memories using hybrid retrieval (LanceDB + Mem0 fallback)',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          userId: { type: 'string', description: 'User identifier' },
          topK: { type: 'number', default: 5, description: 'Number of results' },
          filters: {
            type: 'object',
            properties: {
              scope: { type: 'string', enum: ['long-term', 'session'] },
              status: { type: 'string', enum: ['active', 'superseded', 'deleted'] },
              categories: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        required: ['query', 'userId'],
      },
      async execute(_id: string, params: any) {
        const result = await customSearch.execute(params);
        return textResult(`memorySearch: source=${result.source}, hits=${result.memories.length}`, result);
      },
    },
  );

  // 自定义写入（统一走 TS bridge，同步到本地 LanceDB，按配置可先写 Mem0）
  api.registerTool(
    {
      name: 'memoryStore',
      description: 'Store a new memory with async sync to LanceDB via Mem0',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Memory content' },
          userId: { type: 'string', description: 'User identifier' },
          scope: { type: 'string', enum: ['long-term', 'session'], default: 'long-term' },
          metadata: { type: 'object', description: 'Additional metadata' },
          categories: { type: 'array', items: { type: 'string' }, description: 'Memory categories' },
        },
        required: ['text', 'userId'],
      },
      async execute(_id: string, params: any) {
        const result = await customStore.execute(params);
        return textResult(`memoryStore: success=${Boolean(result.success)}, uid=${result.memoryUid || 'n/a'}`, result);
      },
    },
  );

  if (cfg.autoRecall.enabled) {
    registerLifecycleHook(api, 'before_prompt_build', async (...args: any[]) => {
      // before_prompt_build signature: handler(event, ctx)
      // event: { prompt: string, messages: unknown[] }
      // ctx: { agentId?, sessionKey?, sessionId?, workspaceDir? }
      const event = args.length >= 2 ? args[0] : args[0];
      const ctx = args.length >= 2 ? args[1] : {};
      const sessionKey = ctx?.sessionKey || ctx?.agentId || '';
      const latestUserMessage = event?.prompt || getLatestUserMessage(event);
      if (!latestUserMessage) {
        debug.basic('auto_recall.skipped', { reason: 'no_query' });
        return null;
      }

      await runAutoRecall({
        query: String(latestUserMessage),
        userId: 'default',
        config: cfg.autoRecall,
        debug,
        search: (params) => customSearch.execute(params),
      });

      // Surface pending capture notification from previous turn
      if (sessionKey) {
        readAndClearPendingCapture(sessionKey);
      }

      return null;
    }, { name: 'mem0-auto-recall' });
  }

  if (cfg.autoCapture.enabled) {
    registerLifecycleHook(api, 'agent_end', async (...args: any[]) => {
      // agent_end signature: handler(event, ctx)
      // event: { messages: unknown[], success: boolean, error?: string, durationMs?: number }
      // ctx: { agentId?, sessionKey?, sessionId?, workspaceDir?, messageProvider? }
      const event = args.length >= 2 ? args[0] : args[0];
      const ctx = args.length >= 2 ? args[1] : {};
      const sessionKey = ctx?.sessionKey || ctx?.agentId || '';
      const { latestUserMessage, latestAssistantMessage } = extractLatestMessages(event?.messages);
      debug.basic('auto_capture.hook_invoked', {
        event: 'agent_end',
        messageCount: Array.isArray(event?.messages) ? event.messages.length : 0,
        hasLatestUserMessage: Boolean(latestUserMessage),
        hasLatestAssistantMessage: Boolean(latestAssistantMessage),
        success: event?.success,
      });
      const payload = buildAutoCapturePayload({
        userId: 'default',
        runId: null,
        latestUserMessage,
        latestAssistantMessage,
        config: cfg.autoCapture,
      });
      if (!payload) {
        debug.basic('auto_capture.skipped', { reason: 'no_payload' });
        return null;
      }

      debug.basic('auto_capture.start', {
        userId: payload.userId,
        scope: payload.scope,
        idempotencyKey: payload.idempotencyKey,
        ...summarizeText(payload.messages.map((m) => m.content).join('\n')),
      });
      const mem0Client = new HttpMem0Client(cfg, fetch, debug);
      const submitted = await mem0Client.captureTurn(payload);

      if (submitted.status === 'submitted') {
        // Path A: Mem0 returned extracted memories directly in the response array
        if (submitted.extractedMemories && submitted.extractedMemories.length > 0) {
          const synced = await syncCapturedMemories({
            memories: submitted.extractedMemories,
            userId: payload.userId,
            runId: payload.runId,
            scope: payload.scope,
            eventId: null,
            auditStore: new FileAuditStore(cfg.auditStorePath),
            adapter: new LanceDbMemoryAdapter(cfg.lancedbPath, cfg.embedding),
            debug,
          });
          debug.basic('auto_capture.done', {
            mode: 'direct',
            extractedCount: submitted.extractedMemories.length,
            synced: synced.synced,
          });
          if (sessionKey) {
            writePendingCapture(sessionKey, {
              memories: submitted.extractedMemories.map((m: any) => m.text || String(m)),
              via: 'mem0',
              syncedToLancedb: synced.synced > 0,
              count: submitted.extractedMemories.length,
            });
          }
          return { submitted, synced };
        }

        // Path B: Mem0 returned an event_id for async confirmation
        if (submitted.event_id) {
          const confirmation = await mem0Client.waitForEvent(submitted.event_id, { attempts: 5, delayMs: 400 });
          if (confirmation.status === 'confirmed') {
            const extractedMemories = await mem0Client.fetchCapturedMemories({
              userId: payload.userId,
              eventId: submitted.event_id,
            });
            const synced = await syncCapturedMemories({
              memories: extractedMemories,
              userId: payload.userId,
              runId: payload.runId,
              scope: payload.scope,
              eventId: submitted.event_id,
              auditStore: new FileAuditStore(cfg.auditStorePath),
              adapter: new LanceDbMemoryAdapter(cfg.lancedbPath, cfg.embedding),
              debug,
            });
            debug.basic('auto_capture.done', {
              mode: 'event',
              eventId: submitted.event_id,
              extractedCount: extractedMemories.length,
              synced: synced.synced,
            });
            if (sessionKey && extractedMemories.length > 0) {
              writePendingCapture(sessionKey, {
                memories: extractedMemories.map((m: any) => m.text || String(m)),
                via: 'mem0',
                syncedToLancedb: synced.synced > 0,
                count: extractedMemories.length,
              });
            }
            return { submitted, confirmation, synced };
          }

          debug.basic('auto_capture.unconfirmed', { eventId: submitted.event_id, status: confirmation.status });
          return { submitted, confirmation };
        }
      }

      if (submitted.status === 'submitted' && submitted.extractedMemories?.length === 0) {
        debug.basic('auto_capture.empty', { reason: 'mem0_no_extraction' });
      } else {
        debug.basic('auto_capture.unavailable', { status: submitted.status });
      }
      return { submitted };
    }, { name: 'mem0-auto-capture' });
  }

  api.logger?.info?.(`[openclaw-mem0-lancedb] registered v${PLUGIN_VERSION}`);
}

function readPluginVersion(): string {
  try {
    const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function pendingCapturePath(sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-z0-9]/gi, '_').slice(0, 64);
  return path.join(os.tmpdir(), `mem0-cap-${safe}.json`);
}

function writePendingCapture(sessionKey: string, notification: object): void {
  try {
    fs.writeFileSync(pendingCapturePath(sessionKey), JSON.stringify(notification), 'utf-8');
  } catch {
    // non-fatal
  }
}

function readAndClearPendingCapture(sessionKey: string): Record<string, any> | null {
  const filePath = pendingCapturePath(sessionKey);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    fs.unlinkSync(filePath);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractLatestMessages(messages: unknown[]): { latestUserMessage: string; latestAssistantMessage: string } {
  let latestUserMessage = '';
  let latestAssistantMessage = '';
  if (!Array.isArray(messages)) return { latestUserMessage, latestAssistantMessage };

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    const role = String(msg?.role || msg?.author || '');
    const raw = extractTextContent(msg?.content);
    const content = stripInjectedArtifacts(raw).trim();
    if (!content) continue;
    if (role === 'assistant' && !latestAssistantMessage) {
      latestAssistantMessage = content;
    } else if (role === 'user' && !latestUserMessage) {
      latestUserMessage = content;
    }
    if (latestUserMessage && latestAssistantMessage) break;
  }

  return { latestUserMessage, latestAssistantMessage };
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

function registerLifecycleHook(
  api: OpenClawApi,
  event: string,
  handler: (...args: any[]) => any,
  opts?: any,
): void {
  if (typeof api.on === 'function') {
    api.on(event, handler, opts);
    return;
  }

  if (typeof api.registerHook === 'function') {
    api.registerHook(event, handler, opts);
  }
}

function getLatestUserMessage(context: any): string {
  if (context?.latestUserMessage || context?.input || context?.message) {
    return String(context?.latestUserMessage || context?.input || context?.message || '');
  }

  if (Array.isArray(context?.messages)) {
    for (let index = context.messages.length - 1; index >= 0; index -= 1) {
      const message = context.messages[index];
      const role = String(message?.role || message?.author || '');
      if (role === 'user' && message?.content) {
        return String(message.content);
      }
    }
  }

  return '';
}
