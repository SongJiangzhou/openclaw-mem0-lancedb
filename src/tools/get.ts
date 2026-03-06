import { FileAuditStore } from '../audit/store';
import type { PluginConfig, MemoryRecord } from '../types';

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
    const auditStore = new FileAuditStore(this.config.auditStorePath);
    const latest = await auditStore.findLatestByFilePath(targetPath) as MemoryRecord | null;
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
}
