import { promises as fs } from 'node:fs';
import * as path from 'node:path';

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
    const rows = await this.readAll();
    const matches = rows.filter((row) => row.openclaw_refs?.file_path === filePath);
    if (matches.length === 0) {
      return null;
    }

    matches.sort((left, right) => right.ts_event.localeCompare(left.ts_event));
    return matches[0];
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
