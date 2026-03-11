import test from 'node:test';
import assert from 'node:assert/strict';

import { backfillLifecycleFields, computeRetentionDeadline, initializeLifecycleFields, mapStatusToLifecycleState } from '../../src/memory/lifecycle';

test('initializeLifecycleFields sets deterministic defaults', () => {
  const result = initializeLifecycleFields({
    tsEvent: '2026-03-11T00:00:00.000Z',
    status: 'active',
    scope: 'long-term',
    sensitivity: 'internal',
  });

  assert.equal(result.lifecycle_state, 'active');
  assert.equal(result.strength, 0.6);
  assert.equal(result.stability, 30);
  assert.equal(result.access_count, 0);
  assert.equal(result.inhibition_weight, 0);
  assert.equal(result.utility_score, 0.5);
  assert.equal(result.risk_score, 0.5);
  assert.match(result.next_review_ts, /^2026-04-/);
  assert.match(result.retention_deadline, /^2026-09-/);
});

test('backfillLifecycleFields preserves existing lifecycle values and fills missing ones', () => {
  const result = backfillLifecycleFields({
    text: 'User prefers tea.',
    ts_event: '2026-03-11T00:00:00.000Z',
    scope: 'long-term',
    status: 'active',
    lifecycle_state: 'reinforced',
    strength: 0.9,
    utility_score: 0.7,
  });

  assert.equal(result.lifecycle_state, 'reinforced');
  assert.equal(result.strength, 0.9);
  assert.equal(result.utility_score, 0.7);
  assert.equal(result.stability, 30);
  assert.equal(result.retention_deadline.startsWith('2026-09-'), true);
});

test('retention deadline shortens for session and restricted memories', () => {
  const sessionDeadline = computeRetentionDeadline('2026-03-11T00:00:00.000Z', 'session', 'internal');
  const restrictedDeadline = computeRetentionDeadline('2026-03-11T00:00:00.000Z', 'long-term', 'restricted');

  assert.match(sessionDeadline, /^2026-03-18/);
  assert.match(restrictedDeadline, /^2026-04-10/);
});

test('mapStatusToLifecycleState keeps status alignment', () => {
  assert.equal(mapStatusToLifecycleState('active'), 'active');
  assert.equal(mapStatusToLifecycleState('superseded'), 'superseded');
  assert.equal(mapStatusToLifecycleState('deleted'), 'deleted');
});
