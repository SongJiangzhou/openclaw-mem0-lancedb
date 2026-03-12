import assert from 'node:assert/strict';
import test from 'node:test';

import { payloadToRecord, recordToPayload } from '../../src/memory/mapper';
import type { MemoryRecord, MemorySyncPayload } from '../../src/types';

function buildPayload(): MemorySyncPayload {
  return {
    user_id: 'user-1',
    session_id: 'session-1',
    agent_id: 'agent-1',
    run_id: 'run-1',
    scope: 'long-term',
    text: 'User prefers concise answers',
    categories: ['preference'],
    tags: ['style'],
    memory_type: 'generic',
    domains: ['generic'],
    source_kind: 'user_explicit',
    confidence: 0.9,
    ts_event: '2026-03-13T01:00:00.000Z',
    source: 'openclaw',
    status: 'active',
    sensitivity: 'internal',
    openclaw_refs: { file_path: 'MEMORY.md' },
    mem0: { mem0_id: 'mem0-1', event_id: 'event-1', hash: 'hash-1' },
  };
}

test('payloadToRecord maps base fields', () => {
  const payload = buildPayload();

  const record = payloadToRecord('memory-1', payload);

  assert.equal(record.memory_uid, 'memory-1');
  assert.equal(record.user_id, payload.user_id);
  assert.equal(record.text, payload.text);
  assert.deepEqual(record.openclaw_refs, payload.openclaw_refs);
  assert.deepEqual(record.mem0, payload.mem0);
});

test('payloadToRecord preserves optional lancedb provenance overrides', () => {
  const payload = buildPayload();

  const record = payloadToRecord('memory-1', payload, {
    lancedb: {
      table: 'memory_records',
      row_key: 'memory-1',
      vector_dim: 16,
      index_version: null,
    },
  });

  assert.deepEqual(record.lancedb, {
    table: 'memory_records',
    row_key: 'memory-1',
    vector_dim: 16,
    index_version: null,
  });
});

test('recordToPayload ignores lancedb metadata', () => {
  const record: MemoryRecord = {
    ...payloadToRecord('memory-1', buildPayload()),
    lancedb: {
      table: 'memory_records',
      row_key: 'memory-1',
      vector_dim: 16,
      index_version: 'rrf-v1',
    },
  };

  const payload = recordToPayload(record);

  assert.equal(payload.user_id, record.user_id);
  assert.equal(payload.text, record.text);
  assert.equal('lancedb' in payload, false);
});
