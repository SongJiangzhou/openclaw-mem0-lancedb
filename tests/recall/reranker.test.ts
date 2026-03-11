import assert from 'node:assert/strict';
import test from 'node:test';

import { createRecallReranker } from '../../src/recall/reranker';
import type { MemoryRecord, RecallRerankerConfig } from '../../src/types';

function buildMemory(text: string): MemoryRecord {
  return {
    memory_uid: `m-${text}`,
    user_id: 'user-1',
    run_id: null,
    scope: 'long-term',
    text,
    categories: ['preference'],
    tags: [],
    ts_event: '2026-03-07T12:00:00.000Z',
    source: 'openclaw',
    status: 'active',
    sensitivity: 'internal',
    openclaw_refs: { file_path: 'MEMORY.md' },
    mem0: {},
    lancedb: {},
  };
}

test('createRecallReranker uses Voyage rerank API when configured', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const reranker = createRecallReranker(
    {
      provider: 'voyage',
      baseUrl: 'https://api.voyageai.com/v1',
      apiKey: 'voyage-key',
      model: 'rerank-2.5-lite',
    },
    (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body || '{}')) });
      return {
        ok: true,
        json: async () => ({
          data: [
            { index: 1, relevance_score: 0.91 },
            { index: 0, relevance_score: 0.42 },
          ],
        }),
      } as any;
    }) as typeof fetch,
  );

  const ranked = await reranker.rerank(
    [buildMemory('User likes tea'), buildMemory('User likes coffee')],
    'What drink do I like?',
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.voyageai.com/v1/rerank');
  assert.equal(calls[0]?.body.query, 'What drink do I like?');
  assert.equal(calls[0]?.body.model, 'rerank-2.5-lite');
  assert.deepEqual(calls[0]?.body.documents, ['User likes tea', 'User likes coffee']);
  assert.equal(ranked[0]?.text, 'User likes coffee');
});

test('createRecallReranker falls back to local reranker when Voyage rerank fails', async () => {
  const config: RecallRerankerConfig = {
    provider: 'voyage',
    baseUrl: 'https://api.voyageai.com/v1',
    apiKey: 'voyage-key',
    model: 'rerank-2.5-lite',
  };
  const reranker = createRecallReranker(
    config,
    (async () => {
      throw new Error('voyage failed');
    }) as typeof fetch,
  );

  const ranked = await reranker.rerank(
    [buildMemory('User likes KFC egg tarts'), buildMemory('User likes McDonalds grilled chicken burger')],
    'What do I like at McDonalds?',
  );

  assert.equal(ranked[0]?.text, 'User likes McDonalds grilled chicken burger');
});
