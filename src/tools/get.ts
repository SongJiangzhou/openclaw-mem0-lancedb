import { LanceDbMemoryAdapter } from '../bridge/adapter';
import type { MemorySyncPayload, PluginConfig } from '../types';

type GetParams = {
  path: string;
  from?: number;
  lines?: number;
};

export class MemoryGetTool {
  private config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
  }

  async execute(params: GetParams): Promise<{ path: string; from: number; lines: number; text: string }> {
    const targetPath = params.path;
    const from = Math.max(1, Number(params.from || 1));
    const lines = Math.max(1, Number(params.lines || 50));
    const adapter = new LanceDbMemoryAdapter(this.config.lancedbPath, this.config.embedding);
    const latest = await this.findLatestByFilePath(adapter, targetPath);

    if (!latest) {
      return { path: targetPath, from, lines, text: '' };
    }

    const all = String(latest.text || '').split('\n');
    const slice = all.slice(from - 1, from - 1 + lines).join('\n');

    return {
      path: targetPath,
      from,
      lines,
      text: slice,
    };
  }

  private async findLatestByFilePath(
    adapter: LanceDbMemoryAdapter,
    targetPath: string,
  ): Promise<MemorySyncPayload | null> {
    const rows = await adapter.listMemories({ status: 'active' });
    const matched = rows
      .filter((row) => String(row.memory.openclaw_refs?.file_path || '') === targetPath)
      .sort((left, right) => String(right.memory.ts_event || '').localeCompare(String(left.memory.ts_event || '')));
    return matched[0]?.memory || null;
  }
}
