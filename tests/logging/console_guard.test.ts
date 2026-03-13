import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const REPO_ROOT = resolve(__dirname, '..', '..');

test('src does not use direct console logging', async () => {
  let output = '';

  try {
    output = execFileSync(
      'rg',
      ['-n', 'console\\.(warn|error|log)', 'src'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
  } catch (error: any) {
    if (error?.status === 1) {
      output = '';
    } else {
      throw error;
    }
  }

  assert.equal(output.trim(), '');
});
