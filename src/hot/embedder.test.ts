import assert from 'node:assert/strict';
import test from 'node:test';

import { EMBEDDING_DIM, embedText } from './embedder';

test('embedText is stable for identical input', () => {
  const first = embedText('用户偏好：中文回复');
  const second = embedText('用户偏好：中文回复');

  assert.deepEqual(first, second);
});

test('embedText returns fixed-dimension vectors', () => {
  const vector = embedText('用户偏好：中文回复');

  assert.equal(vector.length, EMBEDDING_DIM);
});

test('embedText does not collapse all inputs to the same vector', () => {
  const first = embedText('用户偏好：中文回复');
  const second = embedText('用户喜欢科幻电影');

  assert.notDeepEqual(first, second);
});
