import test from 'node:test';
import assert from 'node:assert/strict';

import {
  backfillLifecycleFields,
  computeEffectiveStrength,
  computeRetentionDeadline,
  initializeLifecycleFields,
  mapStatusToLifecycleState,
  shouldInhibitLifecycle,
  shouldQuarantineLifecycle,
  shouldQuarantineSessionLifecycle,
} from '../../src/memory/lifecycle';

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

test('session lifecycle defaults are shorter lived than long-term memory', () => {
  const result = initializeLifecycleFields({
    tsEvent: '2026-03-11T00:00:00.000Z',
    status: 'active',
    scope: 'session',
    sensitivity: 'internal',
  });

  assert.equal(result.stability, 1);
  assert.match(result.next_review_ts, /^2026-03-12/);
});

test('session memories quarantine after one day of inactivity', () => {
  const shouldQuarantine = shouldQuarantineSessionLifecycle({
    scope: 'session',
    status: 'active',
    lifecycle_state: 'active',
    ts_event: '2026-03-11T00:00:00.000Z',
    last_access_ts: '2026-03-11T00:00:00.000Z',
    retention_deadline: '2026-03-18T00:00:00.000Z',
  }, '2026-03-12T12:00:00.000Z');

  assert.equal(shouldQuarantine, true);
});

test('auto fade-out ignores weak stale user-explicit memories for quarantine and inhibition', () => {
  const row = {
    scope: 'long-term' as const,
    status: 'active' as const,
    lifecycle_state: 'active' as const,
    source_kind: 'user_explicit' as const,
    ts_event: '2026-01-01T00:00:00.000Z',
    last_access_ts: '2026-01-01T00:00:00.000Z',
    stability: 10,
    strength: 0.2,
    utility_score: 0.1,
    access_count: 0,
    retention_deadline: '2026-12-31T00:00:00.000Z',
  };

  assert.equal(shouldInhibitLifecycle(row, '2026-03-13T00:00:00.000Z'), false);
  assert.equal(shouldQuarantineLifecycle(row, '2026-03-13T00:00:00.000Z'), false);
});

test('auto fade-out uses last access and effective strength for inferred memories', () => {
  const row = {
    scope: 'long-term' as const,
    status: 'active' as const,
    lifecycle_state: 'active' as const,
    source_kind: 'assistant_inferred' as const,
    ts_event: '2026-01-01T00:00:00.000Z',
    last_access_ts: '2026-01-01T00:00:00.000Z',
    stability: 10,
    strength: 0.2,
    utility_score: 0.15,
    access_count: 0,
    retention_deadline: '2026-12-31T00:00:00.000Z',
  };

  assert.equal(
    computeEffectiveStrength({
      strength: row.strength,
      stability: row.stability,
      last_access_ts: row.last_access_ts,
      now: '2026-03-13T00:00:00.000Z',
    }) < 0.05,
    true,
  );
  assert.equal(shouldInhibitLifecycle(row, '2026-03-13T00:00:00.000Z'), true);
  assert.equal(shouldQuarantineLifecycle(row, '2026-03-13T00:00:00.000Z'), true);
});

test('mapStatusToLifecycleState keeps status alignment', () => {
  assert.equal(mapStatusToLifecycleState('active'), 'active');
  assert.equal(mapStatusToLifecycleState('superseded'), 'superseded');
  assert.equal(mapStatusToLifecycleState('deleted'), 'deleted');
});
