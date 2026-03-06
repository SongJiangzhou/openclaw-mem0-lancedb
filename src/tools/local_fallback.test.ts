import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStoreTool } from './store';
import { MemorySearchTool } from './search';

test('store/search works with local fallback when mem0ApiKey is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem0-lancedb-test-'));
  try {
    const cfg = {
      lancedbPath: dir,
      mem0BaseUrl: 'http://127.0.0.1:9',
      mem0ApiKey: '',
      outboxDbPath: join(dir, 'outbox.db'),
    };

    const store = new MemoryStoreTool(cfg);
    const search = new MemorySearchTool(cfg);

    const write = await store.execute({
      text: '用户偏好：回复必须使用中文',
      userId: 'railgun',
      scope: 'long-term',
      categories: ['preference'],
    });

    assert.equal(write.success, true);

    const result = await search.execute({
      query: '回复必须使用中文',
      userId: 'railgun',
      topK: 3,
    });

    assert.equal(result.source, 'lancedb');
    assert.ok(result.memories.length >= 1);
    assert.match(result.memories[0].text, /回复必须使用中文/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
