import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import type { MemoryRecord } from '../types';

export class FileAuditStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async append(record: MemoryRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  async findLatestByFilePath(filePath: string): Promise<MemoryRecord | null> {
    try {
      const input = createReadStream(this.filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input, crlfDelay: Infinity });
      let latest: MemoryRecord | null = null;

      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        try {
          const row = JSON.parse(line) as MemoryRecord;
          if (row.openclaw_refs?.file_path !== filePath) {
            continue;
          }
          if (!latest || String(row.ts_event || '') > String(latest.ts_event || '')) {
            latest = row;
          }
        } catch {
          continue;
        }
      }

      return latest;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async readLatestRows(): Promise<MemoryRecord[]> {
    try {
      const input = createReadStream(this.filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input, crlfDelay: Infinity });
      const latestByUid = new Map<string, MemoryRecord>();

      for await (const rawLine of rl) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        try {
          const row = JSON.parse(line) as MemoryRecord;
          const existing = latestByUid.get(row.memory_uid);
          if (!existing || String(row.ts_event || '') > String(existing.ts_event || '')) {
            latestByUid.set(row.memory_uid, row);
          }
        } catch {
          continue;
        }
      }

      return Array.from(latestByUid.values());
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async readAll(): Promise<MemoryRecord[]> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as MemoryRecord];
          } catch {
            return [];
          }
        });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}
