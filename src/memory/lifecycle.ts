import type { LifecycleState, MemoryRecord, MemorySyncPayload } from '../types';

const DEFAULT_STRENGTH = 0.6;
const DEFAULT_STABILITY_DAYS = 30;
const DEFAULT_SESSION_STRENGTH = 0.35;
const DEFAULT_SESSION_STABILITY_DAYS = 1;
const DEFAULT_UTILITY = 0.5;
const RETENTION_DAY_BY_SENSITIVITY: Record<string, number> = {
  restricted: 30,
  confidential: 90,
  internal: 180,
  public: 365,
};

export type MemoryLifecycleFields = {
  lifecycle_state: LifecycleState;
  strength: number;
  stability: number;
  last_access_ts: string;
  next_review_ts: string;
  access_count: number;
  inhibition_weight: number;
  inhibition_until: string;
  utility_score: number;
  risk_score: number;
  retention_deadline: string;
};

export function initializeLifecycleFields(input: {
  tsEvent: string;
  status: 'active' | 'superseded' | 'deleted';
  scope: 'long-term' | 'session';
  sensitivity?: 'public' | 'internal' | 'confidential' | 'restricted';
}): MemoryLifecycleFields {
  const tsEvent = input.tsEvent || new Date().toISOString();
  const stabilityDays = input.scope === 'session' ? DEFAULT_SESSION_STABILITY_DAYS : DEFAULT_STABILITY_DAYS;
  const strength = input.scope === 'session' ? DEFAULT_SESSION_STRENGTH : DEFAULT_STRENGTH;
  return {
    lifecycle_state: mapStatusToLifecycleState(input.status),
    strength,
    stability: stabilityDays,
    last_access_ts: tsEvent,
    next_review_ts: addDays(tsEvent, stabilityDays),
    access_count: 0,
    inhibition_weight: 0,
    inhibition_until: '',
    utility_score: DEFAULT_UTILITY,
    risk_score: computeRiskScore(input.sensitivity || 'internal'),
    retention_deadline: computeRetentionDeadline(tsEvent, input.scope, input.sensitivity || 'internal'),
  };
}

export function backfillLifecycleFields<T extends Partial<MemoryRecord> | Partial<MemorySyncPayload>>(row: T): T & MemoryLifecycleFields {
  const tsEvent = String(row.ts_event || new Date().toISOString());
  const status = (row.status || 'active') as 'active' | 'superseded' | 'deleted';
  const scope = (row.scope || 'long-term') as 'long-term' | 'session';
  const sensitivity = (row.sensitivity || 'internal') as 'public' | 'internal' | 'confidential' | 'restricted';
  const initialized = initializeLifecycleFields({ tsEvent, status, scope, sensitivity });

  return {
    ...initialized,
    ...row,
    lifecycle_state: normalizeLifecycleState(String(row.lifecycle_state || ''), status),
    strength: coerceFiniteNumber(row.strength, initialized.strength),
    stability: coerceFiniteNumber(row.stability, initialized.stability),
    last_access_ts: String(row.last_access_ts || initialized.last_access_ts),
    next_review_ts: String(row.next_review_ts || initialized.next_review_ts),
    access_count: coerceFiniteNumber(row.access_count, initialized.access_count),
    inhibition_weight: coerceFiniteNumber(row.inhibition_weight, initialized.inhibition_weight),
    inhibition_until: String(row.inhibition_until || initialized.inhibition_until),
    utility_score: coerceFiniteNumber(row.utility_score, initialized.utility_score),
    risk_score: coerceFiniteNumber(row.risk_score, initialized.risk_score),
    retention_deadline: String(row.retention_deadline || initialized.retention_deadline),
  };
}

export function mapStatusToLifecycleState(status: 'active' | 'superseded' | 'deleted'): LifecycleState {
  switch (status) {
    case 'superseded':
      return 'superseded';
    case 'deleted':
      return 'deleted';
    default:
      return 'active';
  }
}

export function isRecallEligibleLifecycleState(state?: string): boolean {
  return state !== 'deleted' && state !== 'quarantined' && state !== 'superseded';
}

export function computeEffectiveStrength(input: {
  strength?: number;
  stability?: number;
  last_access_ts?: string;
  now?: string;
}): number {
  const strength = typeof input.strength === 'number' ? input.strength : DEFAULT_STRENGTH;
  const stability = typeof input.stability === 'number' && input.stability > 0 ? input.stability : DEFAULT_STABILITY_DAYS;
  const lastAccessTs = String(input.last_access_ts || input.now || new Date().toISOString());
  const now = new Date(input.now || new Date().toISOString()).getTime();
  const lastAccess = new Date(lastAccessTs).getTime();
  const ageDays = Math.max(0, (now - lastAccess) / (1000 * 60 * 60 * 24));
  return Math.max(0, Math.min(1, strength * Math.exp(-Math.log(2) * ageDays / stability)));
}

export function reinforceLifecycle<T extends Partial<MemoryRecord>>(row: T, nowIso: string = new Date().toISOString()): T & MemoryLifecycleFields {
  const existing = backfillLifecycleFields(row);
  const effectiveStrength = computeEffectiveStrength({
    strength: existing.strength,
    stability: existing.stability,
    last_access_ts: existing.last_access_ts,
    now: nowIso,
  });
  const nextStrength = Math.min(1, effectiveStrength + (0.15 * (1 - effectiveStrength)));
  const nextStability = Math.min(180, existing.stability * 1.15);

  return {
    ...existing,
    strength: nextStrength,
    stability: nextStability,
    last_access_ts: nowIso,
    next_review_ts: scheduleNextReview(nowIso, nextStability),
    access_count: existing.access_count + 1,
    utility_score: Math.min(1, existing.utility_score + 0.05),
    lifecycle_state: 'reinforced',
  };
}

export function refreshReviewLifecycle<T extends Partial<MemoryRecord>>(row: T, nowIso: string = new Date().toISOString()): T & MemoryLifecycleFields {
  const existing = backfillLifecycleFields(row);
  const effectiveStrength = computeEffectiveStrength({
    strength: existing.strength,
    stability: existing.stability,
    last_access_ts: existing.last_access_ts,
    now: nowIso,
  });
  const nextStrength = Math.min(1, effectiveStrength + (0.08 * (1 - effectiveStrength)));
  const nextStability = Math.min(180, existing.stability * 1.08);
  return {
    ...existing,
    strength: nextStrength,
    stability: nextStability,
    next_review_ts: scheduleNextReview(nowIso, nextStability),
    lifecycle_state: 'reinforced',
    ts_event: nowIso,
  };
}

export function inhibitLifecycle<T extends Partial<MemoryRecord>>(row: T, nowIso: string = new Date().toISOString(), days = 14): T & MemoryLifecycleFields {
  const existing = backfillLifecycleFields(row);
  return {
    ...existing,
    lifecycle_state: 'inhibited',
    inhibition_weight: Math.max(existing.inhibition_weight, 0.5),
    inhibition_until: addDays(nowIso, days),
    ts_event: nowIso,
  };
}

export function quarantineLifecycle<T extends Partial<MemoryRecord>>(row: T, nowIso: string = new Date().toISOString()): T & MemoryLifecycleFields {
  const existing = backfillLifecycleFields(row);
  return {
    ...existing,
    lifecycle_state: 'quarantined',
    ts_event: nowIso,
  };
}

export function deleteLifecycle<T extends Partial<MemoryRecord>>(row: T, nowIso: string = new Date().toISOString()): T & MemoryLifecycleFields {
  const existing = backfillLifecycleFields(row);
  return {
    ...existing,
    status: 'deleted',
    lifecycle_state: 'deleted',
    ts_event: nowIso,
  };
}

export function restoreLifecycle<T extends Partial<MemoryRecord>>(row: T, nowIso: string = new Date().toISOString()): T & MemoryLifecycleFields {
  const existing = backfillLifecycleFields(row);
  return {
    ...existing,
    lifecycle_state: 'active',
    inhibition_weight: 0,
    inhibition_until: '',
    ts_event: nowIso,
  };
}

export function shouldReviewLifecycle(row: Partial<MemoryRecord>, nowIso: string = new Date().toISOString()): boolean {
  const existing = backfillLifecycleFields(row);
  if (existing.status !== 'active' || existing.scope !== 'long-term') {
    return false;
  }
  if (existing.lifecycle_state === 'quarantined' || existing.lifecycle_state === 'deleted' || existing.lifecycle_state === 'superseded') {
    return false;
  }
  if (existing.utility_score < 0.45 || existing.strength < 0.45) {
    return false;
  }
  return new Date(existing.next_review_ts).getTime() <= new Date(nowIso).getTime();
}

export function shouldDeleteForRetention(row: Partial<MemoryRecord>, nowIso: string = new Date().toISOString()): boolean {
  const existing = backfillLifecycleFields(row);
  const deadline = new Date(existing.retention_deadline).getTime();
  if (Number.isNaN(deadline)) {
    return false;
  }
  return deadline <= new Date(nowIso).getTime();
}

export function shouldQuarantineLifecycle(row: Partial<MemoryRecord>, nowIso: string = new Date().toISOString()): boolean {
  const existing = backfillLifecycleFields(row);
  if (shouldQuarantineSessionLifecycle(existing, nowIso)) {
    return true;
  }
  const ageDays = computeLifecycleAgeDays(existing, nowIso);
  const effectiveStrength = computeEffectiveStrength({
    strength: existing.strength,
    stability: existing.stability,
    last_access_ts: existing.last_access_ts,
    now: nowIso,
  });
  return existing.status === 'active'
    && existing.lifecycle_state !== 'quarantined'
    && existing.lifecycle_state !== 'deleted'
    && existing.lifecycle_state !== 'superseded'
    && isAutoFadeEligibleSource(existing.source_kind)
    && existing.access_count === 0
    && existing.utility_score <= 0.2
    && effectiveStrength < 0.1
    && ageDays >= 45;
}

export function shouldQuarantineSessionLifecycle(row: Partial<MemoryRecord>, nowIso: string = new Date().toISOString()): boolean {
  const existing = backfillLifecycleFields(row);
  if (existing.scope !== 'session' || existing.status !== 'active') {
    return false;
  }
  if (existing.lifecycle_state === 'quarantined' || existing.lifecycle_state === 'deleted' || existing.lifecycle_state === 'superseded') {
    return false;
  }
  const lastAccess = new Date(existing.last_access_ts || existing.ts_event || nowIso).getTime();
  const ageHours = Math.max(0, (new Date(nowIso).getTime() - lastAccess) / (1000 * 60 * 60));
  return ageHours >= 24;
}

export function shouldInhibitLifecycle(row: Partial<MemoryRecord>, nowIso: string = new Date().toISOString()): boolean {
  const existing = backfillLifecycleFields(row);
  const effectiveStrength = computeEffectiveStrength({
    strength: existing.strength,
    stability: existing.stability,
    last_access_ts: existing.last_access_ts,
    now: nowIso,
  });
  const ageDays = computeLifecycleAgeDays(existing, nowIso);
  return existing.status === 'active'
    && existing.lifecycle_state === 'active'
    && isAutoFadeEligibleSource(existing.source_kind)
    && existing.utility_score < 0.25
    && effectiveStrength < 0.2
    && ageDays >= 14;
}

export function inhibitionExpired(row: Partial<MemoryRecord>, nowIso: string = new Date().toISOString()): boolean {
  const existing = backfillLifecycleFields(row);
  if (existing.lifecycle_state !== 'inhibited' || !existing.inhibition_until) {
    return false;
  }
  return new Date(existing.inhibition_until).getTime() <= new Date(nowIso).getTime();
}

export function computeRiskScore(sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'): number {
  switch (sensitivity) {
    case 'restricted':
      return 1;
    case 'confidential':
      return 0.75;
    case 'public':
      return 0.2;
    default:
      return 0.5;
  }
}

export function computeRetentionDeadline(
  tsEvent: string,
  scope: 'long-term' | 'session',
  sensitivity: 'public' | 'internal' | 'confidential' | 'restricted',
): string {
  const days = scope === 'session' ? 7 : RETENTION_DAY_BY_SENSITIVITY[sensitivity] || 180;
  return addDays(tsEvent, days);
}

function addDays(isoTs: string, days: number): string {
  const value = new Date(isoTs);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString();
}

function scheduleNextReview(nowIso: string, stabilityDays: number): string {
  if (stabilityDays <= 14) return addDays(nowIso, 7);
  if (stabilityDays <= 30) return addDays(nowIso, 14);
  if (stabilityDays <= 90) return addDays(nowIso, 30);
  return addDays(nowIso, 60);
}

function coerceFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeLifecycleState(value: string, status: 'active' | 'superseded' | 'deleted'): LifecycleState {
  switch (value) {
    case 'active':
    case 'reinforced':
    case 'inhibited':
    case 'superseded':
    case 'quarantined':
    case 'deleted':
      return value;
    default:
      return mapStatusToLifecycleState(status);
  }
}

function isAutoFadeEligibleSource(sourceKind: string | undefined): boolean {
  return sourceKind === 'assistant_inferred' || sourceKind === 'system_generated';
}

function computeLifecycleAgeDays(row: Partial<MemoryRecord>, nowIso: string): number {
  const referenceTs = String(row.last_access_ts || row.ts_event || nowIso);
  return Math.max(0, (new Date(nowIso).getTime() - new Date(referenceTs).getTime()) / (1000 * 60 * 60 * 24));
}
