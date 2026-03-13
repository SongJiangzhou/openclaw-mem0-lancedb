import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PluginDebugLogger } from '../../src/debug/logger';

test('debug logger suppresses debug output when mode is off', async () => {
  const messages: string[] = [];
  const logger = new PluginDebugLogger(
    { mode: 'off' },
    {
      info: (msg: string) => messages.push(msg),
      warn: (msg: string) => messages.push(msg),
      error: (msg: string) => messages.push(msg),
    },
  );

  logger.basic('memory_store.start', { userId: 'user-1' });
  logger.verbose('memory_store.payload', { text: 'secret text' });

  assert.equal(messages.length, 0);
});

test('debug logger emits both basic and verbose events in debug mode', async () => {
  const messages: string[] = [];
  const logger = new PluginDebugLogger(
    { mode: 'debug' },
    {
      info: (msg: string) => messages.push(msg),
      warn: (msg: string) => messages.push(msg),
      error: (msg: string) => messages.push(msg),
    },
  );

  logger.basic('memory_store.start', { userId: 'user-1' });
  logger.verbose('memory_store.payload', { text: 'secret text' });

  assert.equal(messages.length, 2);
  assert.match(messages[0] || '', /memory_store\.start/);
  assert.match(messages[1] || '', /memory_store\.payload/);
});

test('debug logger redacts api keys and truncates text previews in debug mode', async () => {
  const messages: string[] = [];
  const logger = new PluginDebugLogger(
    { mode: 'debug' },
    {
      info: (msg: string) => messages.push(msg),
      warn: (msg: string) => messages.push(msg),
      error: (msg: string) => messages.push(msg),
    },
  );

  logger.verbose('mem0.capture.payload', {
    mem0ApiKey: 'super-secret-key',
    text: 'x'.repeat(260),
  });

  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0] || '', /super-secret-key/);
  assert.match(messages[0] || '', /\[redacted\]/);
  assert.match(messages[0] || '', /text_preview/);
});

test('debug logger writes dated log files in the fixed workspace log directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debug-logger-'));
  const previousHome = process.env.HOME;
  process.env.HOME = dir;

  try {
    const logger = new PluginDebugLogger({ mode: 'debug' });
    logger.basic('auto_capture.submitted', { eventId: 'evt-1', userId: 'user-1' });

    const date = new Intl.DateTimeFormat('sv-SE', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const file = join(dir, '.openclaw', 'workspace', 'logs', 'openclaw-mem0-lancedb', `${date}.log`);
    assert.equal(existsSync(file), true);
    assert.match(readFileSync(file, 'utf8'), /auto_capture\.submitted/);
  } finally {
    process.env.HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('debug logger child appends component and base fields', async () => {
  const messages: string[] = [];
  const logger = new PluginDebugLogger(
    { mode: 'debug' },
    {
      info: (msg: string) => messages.push(msg),
      warn: (msg: string) => messages.push(msg),
      error: (msg: string) => messages.push(msg),
    },
  );

  const child = logger.child('memory.search', { feature: 'fallback' });
  child.warn('memory_search.partial', { localCount: 2 });

  assert.equal(messages.length, 1);
  const payload = JSON.parse(messages[0] || '{}');
  assert.equal(payload.event, 'memory_search.partial');
  assert.equal(payload.fields.component, 'memory.search');
  assert.equal(payload.fields.feature, 'fallback');
  assert.equal(payload.fields.localCount, 2);
});

test('debug logger exception serializes error details and contextual fields', async () => {
  const messages: string[] = [];
  const logger = new PluginDebugLogger(
    { mode: 'debug' },
    {
      info: (msg: string) => messages.push(msg),
      warn: (msg: string) => messages.push(msg),
      error: (msg: string) => messages.push(msg),
    },
  );

  const cause = new Error('socket hang up');
  const error = new Error('mem0 search failed', { cause });
  logger.exception('memory_search.mem0_fallback_failed', error, {
    query: 'sparkling water',
    topK: 5,
  });

  assert.equal(messages.length, 1);
  const payload = JSON.parse(messages[0] || '{}');
  assert.equal(payload.level, 'error');
  assert.equal(payload.event, 'memory_search.mem0_fallback_failed');
  assert.equal(payload.fields.message, 'mem0 search failed');
  assert.equal(payload.fields.cause, 'socket hang up');
  assert.equal(payload.fields.query, 'sparkling water');
  assert.equal(payload.fields.topK, 5);
});
