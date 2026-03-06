import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
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

  private resolveLocalStorePath(): string {
    const base = this.config.lancedbPath.startsWith('~/')
      ? path.join(os.homedir(), this.config.lancedbPath.slice(2))
      : this.config.lancedbPath;
    return path.join(base, 'memory_records.jsonl');
  }

  async execute(params: GetParams): Promise<{ path: string; from: number; lines: number; text: string }> {
    const targetPath = params.path;
    const from = Math.max(1, Number(params.from || 1));
    const lines = Math.max(1, Number(params.lines || 50));

    const jsonl = this.resolveLocalStorePath();
    const content = await fs.readFile(jsonl, 'utf-8');
    const rows = content.split('\n').map((l) => l.trim()).filter(Boolean);

    const candidates: MemoryRecord[] = [];
    for (const line of rows) {
      try {
        const r = JSON.parse(line) as MemoryRecord;
        if (r.openclaw_refs?.file_path === targetPath) {
          candidates.push(r);
        }
      } catch {
        // skip malformed row
      }
    }

    const latest = candidates.sort((a, b) => (b.ts_event || '').localeCompare(a.ts_event || ''))[0];
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
