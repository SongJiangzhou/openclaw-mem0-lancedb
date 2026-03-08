import assert from 'node:assert/strict';
import test from 'node:test';

import { isLocalMem0BaseUrl, hasMem0Auth, buildMem0Headers } from '../../src/control/auth';

// --- isLocalMem0BaseUrl ---

test('isLocalMem0BaseUrl returns true for localhost', () => {
  assert.equal(isLocalMem0BaseUrl('http://localhost:8000'), true);
});

test('isLocalMem0BaseUrl returns true for 127.0.0.1', () => {
  assert.equal(isLocalMem0BaseUrl('http://127.0.0.1:8000'), true);
});

test('isLocalMem0BaseUrl returns true for 0.0.0.0', () => {
  assert.equal(isLocalMem0BaseUrl('http://0.0.0.0:8000'), true);
});

test('isLocalMem0BaseUrl returns false for cloud URL', () => {
  assert.equal(isLocalMem0BaseUrl('https://api.mem0.ai'), false);
});

test('isLocalMem0BaseUrl returns false for invalid URL', () => {
  assert.equal(isLocalMem0BaseUrl('not-a-url'), false);
});

test('isLocalMem0BaseUrl returns false for empty string', () => {
  assert.equal(isLocalMem0BaseUrl(''), false);
});

// --- hasMem0Auth ---

test('hasMem0Auth returns true when api key is present', () => {
  assert.equal(hasMem0Auth({ mem0ApiKey: 'test-key', mem0BaseUrl: 'https://api.mem0.ai', mem0Mode: 'remote' }), true);
});

test('hasMem0Auth returns false for cloud URL without api key', () => {
  assert.equal(hasMem0Auth({ mem0ApiKey: '', mem0BaseUrl: 'https://api.mem0.ai', mem0Mode: 'remote' }), false);
});

test('hasMem0Auth returns true for local mode without api key', () => {
  assert.equal(hasMem0Auth({ mem0ApiKey: '', mem0BaseUrl: 'https://api.mem0.ai', mem0Mode: 'local' }), true);
});

test('hasMem0Auth uses explicit local mode over remote-looking url', () => {
  assert.equal(hasMem0Auth({ mem0ApiKey: '', mem0BaseUrl: 'https://api.mem0.ai', mem0Mode: 'local' }), true);
});

test('hasMem0Auth uses explicit remote mode over localhost url', () => {
  assert.equal(hasMem0Auth({ mem0ApiKey: '', mem0BaseUrl: 'http://127.0.0.1:8000', mem0Mode: 'remote' }), false);
});

// --- buildMem0Headers ---

test('buildMem0Headers includes Authorization when api key is present', () => {
  const headers = buildMem0Headers({ mem0ApiKey: 'test-key' });
  assert.equal(headers['Authorization'], 'Token test-key');
  assert.equal(headers['Content-Type'], undefined);
});

test('buildMem0Headers omits Authorization when api key is empty', () => {
  const headers = buildMem0Headers({ mem0ApiKey: '' });
  assert.equal(headers['Authorization'], undefined);
});

test('buildMem0Headers includes Content-Type when json option is true', () => {
  const headers = buildMem0Headers({ mem0ApiKey: 'key' }, { json: true });
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['Authorization'], 'Token key');
});

test('buildMem0Headers with json but no key returns only Content-Type', () => {
  const headers = buildMem0Headers({ mem0ApiKey: '' }, { json: true });
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(headers['Authorization'], undefined);
});
