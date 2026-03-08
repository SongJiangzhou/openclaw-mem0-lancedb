import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const INSTALLER_PATH = resolve(process.cwd(), 'scripts/install.mjs');

function createStubCommand(binDir: string, name: string): void {
  const path = join(binDir, name);
  writeFileSync(
    path,
    `#!/bin/bash
set -e
echo "${name} $*" >> "$STUB_LOG"
`,
  );
  chmodSync(path, 0o755);
}

test('install.mjs --yes writes defaults into openclaw.json', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'install-mjs-yes-'));
  const binDir = join(tempRoot, 'bin');
  const homeDir = join(tempRoot, 'home');
  const logPath = join(tempRoot, 'stub.log');

  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(homeDir, '.openclaw'), { recursive: true });
  writeFileSync(
    join(homeDir, '.openclaw', 'openclaw.json'),
    JSON.stringify({ plugins: { entries: {}, allow: [], load: { paths: [] }, slots: {} } }, null, 2),
  );

  createStubCommand(binDir, 'npm');
  createStubCommand(binDir, 'mkdir');
  createStubCommand(binDir, 'rm');
  createStubCommand(binDir, 'ln');

  const result = spawnSync('node', [INSTALLER_PATH, '--lang', 'en', '--yes'], {
    cwd: resolve(process.cwd()),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      HOME: homeDir,
      STUB_LOG: logPath,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const config = JSON.parse(readFileSync(join(homeDir, '.openclaw', 'openclaw.json'), 'utf8'));
  const pluginConfig = config.plugins.entries['openclaw-mem0-lancedb']?.config;

  assert.equal(pluginConfig?.mem0?.mode, 'remote');
  assert.equal(pluginConfig?.debug?.mode, 'basic');
  assert.equal(pluginConfig?.autoRecall?.enabled, true);
  assert.equal(pluginConfig?.autoRecall?.topK, 8);
  assert.equal(pluginConfig?.autoRecall?.maxChars, 1400);
});

test('install.mjs --skip-config leaves openclaw.json unchanged', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'install-mjs-skip-'));
  const binDir = join(tempRoot, 'bin');
  const homeDir = join(tempRoot, 'home');
  const logPath = join(tempRoot, 'stub.log');

  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(homeDir, '.openclaw'), { recursive: true });
  const originalConfig = { plugins: { entries: {}, allow: [], load: { paths: [] }, slots: {} } };
  writeFileSync(join(homeDir, '.openclaw', 'openclaw.json'), JSON.stringify(originalConfig, null, 2));

  createStubCommand(binDir, 'npm');
  createStubCommand(binDir, 'mkdir');
  createStubCommand(binDir, 'rm');
  createStubCommand(binDir, 'ln');

  const result = spawnSync('node', [INSTALLER_PATH, '--lang', 'zh', '--yes', '--skip-config'], {
    cwd: resolve(process.cwd()),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      HOME: homeDir,
      STUB_LOG: logPath,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const config = JSON.parse(readFileSync(join(homeDir, '.openclaw', 'openclaw.json'), 'utf8'));
  assert.deepEqual(config, originalConfig);
});

test('buildDefaultPluginConfig preserves an existing remote mem0 api key', async () => {
  const installer = await import(INSTALLER_PATH);
  const config = installer.buildDefaultPluginConfig({
    mem0: {
      mode: 'remote',
      baseUrl: 'https://api.mem0.ai',
      apiKey: 'existing-test-key',
    },
  });

  assert.equal(config.mem0.mode, 'remote');
  assert.equal(config.mem0.apiKey, 'existing-test-key');
});

test('install.mjs --yes keeps an existing remote mem0 api key', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'install-mjs-keep-key-'));
  const binDir = join(tempRoot, 'bin');
  const homeDir = join(tempRoot, 'home');
  const logPath = join(tempRoot, 'stub.log');

  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(homeDir, '.openclaw'), { recursive: true });
  writeFileSync(
    join(homeDir, '.openclaw', 'openclaw.json'),
    JSON.stringify(
      {
        plugins: {
          entries: {
            'openclaw-mem0-lancedb': {
              enabled: true,
              config: {
                mem0: {
                  mode: 'remote',
                  baseUrl: 'https://api.mem0.ai',
                  apiKey: 'existing-test-key',
                },
              },
            },
          },
          allow: [],
          load: { paths: [] },
          slots: {},
        },
      },
      null,
      2,
    ),
  );

  createStubCommand(binDir, 'npm');
  createStubCommand(binDir, 'mkdir');
  createStubCommand(binDir, 'rm');
  createStubCommand(binDir, 'ln');

  const result = spawnSync('node', [INSTALLER_PATH, '--lang', 'en', '--yes'], {
    cwd: resolve(process.cwd()),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      HOME: homeDir,
      STUB_LOG: logPath,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const config = JSON.parse(readFileSync(join(homeDir, '.openclaw', 'openclaw.json'), 'utf8'));
  const pluginConfig = config.plugins.entries['openclaw-mem0-lancedb']?.config;
  assert.equal(pluginConfig?.mem0?.apiKey, 'existing-test-key');
});
