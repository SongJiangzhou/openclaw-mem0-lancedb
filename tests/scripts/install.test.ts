import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT_PATH = resolve(process.cwd(), 'scripts/install.sh');
const SCRIPT_ZH_PATH = resolve(process.cwd(), 'scripts/install_zh.sh');

function createStubNode(binDir: string): string {
  const logPath = join(binDir, 'node-invocations.log');
  const path = join(binDir, 'node');
  writeFileSync(
    path,
    `#!/bin/bash
set -e
printf '%s\\n' "$*" >> "${logPath}"
exit 0
`,
  );
  chmodSync(path, 0o755);
  return logPath;
}

test('install.sh forwards to install.mjs with english language flag', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'install-wrapper-en-'));
  const binDir = join(tempRoot, 'bin');

  mkdirSync(binDir, { recursive: true });
  const logPath = createStubNode(binDir);

  const result = spawnSync('bash', [SCRIPT_PATH, '--help'], {
    cwd: resolve(process.cwd()),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  const invocation = readFileSync(logPath, 'utf8');
  assert.match(invocation, /scripts\/install\.mjs/);
  assert.match(invocation, /--lang en/);
  assert.match(invocation, /--help/);
});

test('install_zh.sh forwards to install.mjs with chinese language flag', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'install-wrapper-zh-'));
  const binDir = join(tempRoot, 'bin');

  mkdirSync(binDir, { recursive: true });
  const logPath = createStubNode(binDir);

  const result = spawnSync('bash', [SCRIPT_ZH_PATH, '--yes'], {
    cwd: resolve(process.cwd()),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  const invocation = readFileSync(logPath, 'utf8');
  assert.match(invocation, /scripts\/install\.mjs/);
  assert.match(invocation, /--lang zh/);
  assert.match(invocation, /--yes/);
});
