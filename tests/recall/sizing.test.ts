import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveRecallSizing } from '../../src/recall/sizing';

test('deriveRecallSizing expands topK into stable internal recall sizes', () => {
  const sizing = deriveRecallSizing(5);

  assert.deepEqual(sizing, {
    injectTopK: 5,
    candidateTopK: 12,
    primaryFetchK: 72,
    secondaryFetchK: 48,
    maxQueryVariants: 3,
  });
});
