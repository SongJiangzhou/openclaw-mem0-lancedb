import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAutoCapturePayload } from './auto';
import type { AutoCaptureConfig } from '../types';

function buildConfig(overrides?: Partial<AutoCaptureConfig>): AutoCaptureConfig {
  return {
    enabled: true,
    scope: 'long-term',
    requireAssistantReply: true,
    maxCharsPerMessage: 32,
    ...overrides,
  };
}

test('auto capture builds payload from latest user and assistant messages', () => {
  const payload = buildAutoCapturePayload({
    userId: 'railgun',
    latestUserMessage: '用户要求以后都用中文回复',
    latestAssistantMessage: '好的，之后我会使用中文回复。',
    config: buildConfig(),
  });

  assert.ok(payload);
  assert.equal(payload?.messages.length, 2);
  assert.equal(payload?.messages[0]?.role, 'user');
  assert.equal(payload?.messages[1]?.role, 'assistant');
});

test('auto capture returns null when assistant reply is required but missing', () => {
  const payload = buildAutoCapturePayload({
    userId: 'railgun',
    latestUserMessage: '用户要求以后都用中文回复',
    latestAssistantMessage: '',
    config: buildConfig({ requireAssistantReply: true }),
  });

  assert.equal(payload, null);
});

test('auto capture produces stable idempotency key for identical turn content', () => {
  const first = buildAutoCapturePayload({
    userId: 'railgun',
    latestUserMessage: '用户要求以后都用中文回复',
    latestAssistantMessage: '好的，之后我会使用中文回复。',
    config: buildConfig(),
  });
  const second = buildAutoCapturePayload({
    userId: 'railgun',
    latestUserMessage: '用户要求以后都用中文回复',
    latestAssistantMessage: '好的，之后我会使用中文回复。',
    config: buildConfig(),
  });

  assert.equal(first?.idempotencyKey, second?.idempotencyKey);
});

test('auto capture truncates oversized messages', () => {
  const payload = buildAutoCapturePayload({
    userId: 'railgun',
    latestUserMessage: 'a'.repeat(128),
    latestAssistantMessage: 'b'.repeat(128),
    config: buildConfig({ maxCharsPerMessage: 16 }),
  });

  assert.ok(payload);
  assert.equal(payload?.messages[0]?.content.length, 16);
  assert.equal(payload?.messages[1]?.content.length, 16);
});
