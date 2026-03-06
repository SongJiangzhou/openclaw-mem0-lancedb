import { MemorySearchTool } from './tools/search';
import { MemoryStoreTool } from './tools/store';
import { MemoryGetTool } from './tools/get';
import { buildAutoCapturePayload } from './capture/auto';
import { HttpMem0Client } from './control/mem0';
import { runAutoRecall } from './recall/auto';
import type { PluginConfig } from './types';

type OpenClawApi = {
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  config?: any;
  pluginConfig?: Partial<PluginConfig>;
  registerTool: (tool: any, options?: any) => void;
  registerHook?: (name: string, handler: (...args: any[]) => any) => void;
};

function resolveConfig(raw?: Partial<PluginConfig>): PluginConfig {
  return {
    lancedbPath: raw?.lancedbPath || '~/.openclaw/workspace/data/memory_lancedb',
    mem0BaseUrl: raw?.mem0BaseUrl || 'https://api.mem0.ai',
    mem0ApiKey: raw?.mem0ApiKey || '',
    outboxDbPath: raw?.outboxDbPath || '~/.openclaw/workspace/data/outbox.json',
    auditStorePath: raw?.auditStorePath || '~/.openclaw/workspace/data/memory_audit/memory_records.jsonl',
    autoRecall: {
      enabled: raw?.autoRecall?.enabled || false,
      topK: raw?.autoRecall?.topK || 5,
      maxChars: raw?.autoRecall?.maxChars || 800,
      scope: raw?.autoRecall?.scope || 'all',
    },
    autoCapture: {
      enabled: raw?.autoCapture?.enabled || false,
      scope: raw?.autoCapture?.scope || 'long-term',
      requireAssistantReply: raw?.autoCapture?.requireAssistantReply ?? true,
      maxCharsPerMessage: raw?.autoCapture?.maxCharsPerMessage || 2000,
    },
  };
}

// OpenClaw 插件入口必须是函数或带 register() 的对象，不能直接导出 class。
export default function register(api: OpenClawApi) {
  const cfg = resolveConfig(api.pluginConfig);
  const customSearch = new MemorySearchTool(cfg);
  const customStore = new MemoryStoreTool(cfg);
  const customGet = new MemoryGetTool(cfg);

  // memory slot 主工具：完全走新机制（不再桥接 memory-core）
  api.registerTool({
    name: 'memory_search',
    description: 'Search migrated memories from local LanceDB-side store with optional Mem0 fallback',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        userId: { type: 'string', description: 'User identifier', default: 'railgun' },
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
      const result = await customSearch.execute({ userId: 'railgun', ...params });
      return { content: [{ type: 'json', json: result }] };
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
      return { content: [{ type: 'json', json: result }] };
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
        return { content: [{ type: 'json', json: result }] };
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
        return { content: [{ type: 'json', json: result }] };
      },
    },
  );

  if (cfg.autoRecall.enabled && typeof api.registerHook === 'function') {
    api.registerHook('agent_start', async (context: any) => {
      const latestUserMessage =
        context?.latestUserMessage ||
        context?.input ||
        context?.message ||
        '';
      if (!latestUserMessage) {
        return '';
      }

      return runAutoRecall({
        query: String(latestUserMessage),
        userId: context?.userId || 'railgun',
        config: cfg.autoRecall,
        search: (params) => customSearch.execute(params),
      });
    });
  }

  if (cfg.autoCapture.enabled && typeof api.registerHook === 'function') {
    api.registerHook('agent_end', async (context: any) => {
      const payload = buildAutoCapturePayload({
        userId: context?.userId || 'railgun',
        runId: context?.runId || null,
        latestUserMessage: context?.latestUserMessage || '',
        latestAssistantMessage: context?.latestAssistantMessage || '',
        config: cfg.autoCapture,
      });
      if (!payload) {
        return null;
      }

      const mem0Client = new HttpMem0Client(cfg);
      const submitted = await mem0Client.captureTurn(payload);
      if (submitted.status === 'submitted' && submitted.event_id) {
        const confirmation = await mem0Client.waitForEvent(submitted.event_id, { attempts: 2, delayMs: 0 });
        return { submitted, confirmation };
      }

      return { submitted };
    });
  }

  api.logger?.info?.('[memory-mem0-lancedb] registered');
}
