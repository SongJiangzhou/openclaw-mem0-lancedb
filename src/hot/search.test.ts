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
    await store.execute({
      text: '用户要求所有回答都使用中文进行说明',
      userId: 'railgun',
      scope: 'long-term',
      categories: ['preference'],
    });

    const result = await hot.search({
      query: '中文',
      userId: 'railgun',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    assert.equal(result.source, 'lancedb');
    assert.ok(result.memories.length >= 2);
    assert.equal(result.memories[0]?.user_id, 'railgun');
    assert.equal(result.memories[0]?.scope, 'long-term');
    assert.match(result.memories.map((row) => row.text).join('\n'), /回复必须使用中文/);
    assert.match(result.memories.map((row) => row.text).join('\n'), /所有回答都使用中文进行说明/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hot plane hybrid search includes vector-only candidates through explicit fusion', async () => {
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
      text: 'apple apple apple',
      userId: 'railgun',
      scope: 'long-term',
      categories: ['keyword'],
    });
    await store.execute({
      text: 'banana banana banana',
      userId: 'railgun',
      scope: 'long-term',
      categories: ['vector'],
    });

    const result = await hot.search({
      query: 'apple',
      userId: 'railgun',
      topK: 5,
      filters: { scope: 'long-term' },
    });

    assert.ok(result.memories.length >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
