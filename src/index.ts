import { MemorySearchTool } from './tools/search';
import { MemoryStoreTool } from './tools/store';
import { MemoryGetTool } from './tools/get';
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
};

function resolveConfig(raw?: Partial<PluginConfig>): PluginConfig {
  return {
    lancedbPath: raw?.lancedbPath || '~/.openclaw/workspace/data/memory_lancedb',
    mem0BaseUrl: raw?.mem0BaseUrl || 'https://api.mem0.ai',
    mem0ApiKey: raw?.mem0ApiKey || '',
    outboxDbPath: raw?.outboxDbPath || '~/.openclaw/workspace/data/outbox.db',
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

  // 自定义写入（写 Mem0，后续可接 outbox/LanceDB 同步）
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

  api.logger?.info?.('[memory-mem0-lancedb] registered');
}
