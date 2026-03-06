import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryStoreTool } from '../tools/store';
import { HotMemorySearch } from './search';

test('hot plane search returns canonical memory rows with filters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hot-search-'));

  try {
    const cfg = {
      lancedbPath: dir,
      mem0BaseUrl: '',
      mem0ApiKey: '',
      outboxDbPath: join(dir, 'outbox.json'),
      auditStorePath: join(dir, 'audit', 'memory_records.jsonl'),
    };
    const store = new MemoryStoreTool(cfg);
    const hot = new HotMemorySearch(cfg);

    await store.execute({
      text: '用户偏好：回复必须使用中文',
      userId: 'railgun',
      scope: 'long-term',
      categories: ['preference'],
    });

    const result = await hot.search({
      query: '中文',
      userId: 'railgun',
      topK: 3,
      filters: { scope: 'long-term' },
    });

    assert.equal(result.source, 'lancedb');
    assert.ok(result.memories.length >= 1);
    assert.equal(result.memories[0]?.user_id, 'railgun');
    assert.equal(result.memories[0]?.scope, 'long-term');
    assert.match(result.memories[0]?.text || '', /中文/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
