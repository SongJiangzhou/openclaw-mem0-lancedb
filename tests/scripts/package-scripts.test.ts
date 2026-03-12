import assert from 'node:assert/strict';
import test from 'node:test';

import pkg from '../../package.json';

test('build script removes dist before compiling', () => {
  assert.match(pkg.scripts.build, /rm -rf dist/);
});

test('test script rebuilds dist before executing compiled tests', () => {
  assert.match(pkg.scripts.test, /npm run build/);
});
