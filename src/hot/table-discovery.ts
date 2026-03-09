import * as lancedb from '@lancedb/lancedb';
import * as os from 'node:os';
import * as path from 'node:path';

export interface MemoryTableInfo {
  dimension: number;
  name: string;
}

export function resolveLanceDbPath(dbPath: string): string {
  return dbPath.startsWith('~/')
    ? path.join(os.homedir(), dbPath.slice(2))
    : dbPath;
}

export async function discoverMemoryTables(dbPath: string, currentDim?: number): Promise<MemoryTableInfo[]> {
  const resolvedPath = resolveLanceDbPath(dbPath);
  const db = await lancedb.connect(resolvedPath);
  const tableNames = await db.tableNames();
  const tables: MemoryTableInfo[] = [];

  for (const name of tableNames) {
    if (name === 'memory_records') {
      tables.push({ dimension: 16, name });
      continue;
    }

    if (/^memory_records(?:_d\d+)?_legacy_\d+$/.test(name)) {
      tables.push({ dimension: 0, name });
      continue;
    }

    const dimMatch = name.match(/^memory_records_d(\d+)$/);
    if (dimMatch) {
      tables.push({ dimension: parseInt(dimMatch[1], 10), name });
    }
  }

  if (typeof currentDim === 'number') {
    tables.sort((a, b) => {
      if (a.dimension === currentDim) return -1;
      if (b.dimension === currentDim) return 1;
      return b.dimension - a.dimension;
    });
  }

  return tables;
}
