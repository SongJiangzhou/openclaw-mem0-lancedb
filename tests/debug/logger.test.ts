import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('debug logger mirrors structured events to a JSONL file when logDir is configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debug-logger-'));

  try {
    const logger = new PluginDebugLogger({ mode: 'debug', logDir: dir });
    logger.basic('auto_capture.submitted', { eventId: 'evt-1', userId: 'user-1' });

    const date = new Intl.DateTimeFormat('sv-SE', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const content = readFileSync(join(dir, `${date}.log`), 'utf-8');

    assert.match(content, /auto_capture\.submitted/);
    assert.match(content, /evt-1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
