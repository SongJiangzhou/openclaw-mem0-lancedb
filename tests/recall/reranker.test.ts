import assert from 'node:assert/strict';
import test from 'node:test';

import { createRecallReranker } from '../../src/recall/reranker';
import type { MemoryRecord, RecallRerankerConfig } from '../../src/types';

function buildMemory(text: string, overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    memory_uid: `m-${text}`,
    user_id: 'user-1',
    run_id: null,
    scope: 'long-term',
    text,
    categories: ['preference'],
    tags: [],
    memory_type: 'preference',
    domains: ['food'],
    source_kind: 'user_explicit',
    confidence: 0.9,
    ts_event: '2026-03-07T12:00:00.000Z',
    source: 'openclaw',
    status: 'active',
    sensitivity: 'internal',
    openclaw_refs: { file_path: 'MEMORY.md' },
    mem0: {},
    lancedb: {},
    ...overrides,
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
  assert.match(calls[0]?.body.documents?.[0] || '', /memory_type=preference/);
  assert.match(calls[0]?.body.documents?.[0] || '', /domain=food/);
  assert.match(calls[0]?.body.documents?.[0] || '', /source=user_explicit/);
  assert.match(calls[0]?.body.documents?.[0] || '', /text=User likes tea/);
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

test('createRecallReranker prefers current explicit preference memories over older weaker ones', async () => {
  const reranker = createRecallReranker({
    provider: 'local',
    baseUrl: '',
    apiKey: '',
    model: '',
  });

  const ranked = await reranker.rerank(
    [
      buildMemory('User used to like beef burgers', {
        ts_event: '2025-01-01T12:00:00.000Z',
        last_access_ts: '2025-01-02T12:00:00.000Z',
        source_kind: 'assistant_inferred',
        confidence: 0.55,
      }),
      buildMemory('User now prefers grilled chicken burgers', {
        ts_event: '2026-03-13T12:00:00.000Z',
        last_access_ts: '2026-03-13T12:00:00.000Z',
        source_kind: 'user_explicit',
        confidence: 0.95,
      }),
    ],
    'What do I prefer now?',
  );

  assert.equal(ranked[0]?.text, 'User now prefers grilled chicken burgers');
});

test('createRecallReranker does not penalize a relevant memory just because it mentions workspace-like text', async () => {
  const reranker = createRecallReranker({
    provider: 'local',
    baseUrl: '',
    apiKey: '',
    model: '',
  });

  const ranked = await reranker.rerank(
    [
      buildMemory('User keeps project planning notes in workspace', {
        source_kind: 'assistant_inferred',
      }),
      buildMemory('User keeps planning checklists on paper'),
    ],
    'Where are my project planning notes stored?',
  );

  assert.equal(ranked[0]?.text, 'User keeps project planning notes in workspace');
});
