import assert from 'node:assert/strict';
import test from 'node:test';

import { FAKE_EMBEDDING_DIM, embedText } from '../../src/hot/embedder';

test('embedText is stable for identical input', async () => {
  const first = await embedText('User preference: English replies');
  const second = await embedText('User preference: English replies');

  assert.deepEqual(first, second);
});

test('embedText returns fixed-dimension vectors', async () => {
  const vector = await embedText('User preference: English replies');

  assert.equal(vector.length, FAKE_EMBEDDING_DIM);
});

test('embedText does not collapse all inputs to the same vector', async () => {
  const first = await embedText('User preference: English replies');
  const second = await embedText('User likes sci-fi movies');

  assert.notDeepEqual(first, second);
});

test('embedText throws for unknown provider', async () => {
  const cfg = {
    provider: 'unknown' as any,
    baseUrl: '',
    apiKey: '',
    model: '',
    dimension: 16,
  };

  await assert.rejects(
    () => embedText('hello', cfg),
    /Unknown embedding provider/,
  );
});

test('embedText throws for ollama with empty baseUrl', async () => {
  const cfg = {
    provider: 'ollama' as const,
    baseUrl: '',
    apiKey: '',
    model: '',
    dimension: 768,
  };

  await assert.rejects(
    () => embedText('hello', cfg),
    /ollama provider requires a non-empty baseUrl/,
  );
});

test('embedText uses Voyage embedding API when provider is voyage', async () => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; body: any }> = [];

  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body || '{}')),
    });

    return {
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      }),
    } as any;
  }) as typeof fetch;

  try {
    const vector = await embedText('User preference: English replies', {
      provider: 'voyage' as const,
      baseUrl: 'https://api.voyageai.com/v1',
      apiKey: 'voyage-key',
      model: 'voyage-3.5-lite',
      dimension: 3,
    });

    assert.deepEqual(vector, [0.1, 0.2, 0.3]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.voyageai.com/v1/embeddings');
    assert.equal(calls[0]?.body.model, 'voyage-3.5-lite');
    assert.equal(calls[0]?.body.input, 'User preference: English replies');
  } finally {
    global.fetch = originalFetch;
  }
});
