import assert from 'node:assert/strict';
import test from 'node:test';

import { runMaintenance } from '../../src/maintenance/runner';

test('maintenance runner executes selected actions serially in the expected order', async () => {
  const calls: string[] = [];
  const result = await runMaintenance({
    action: 'all',
    tasks: {
      sync: async () => {
        calls.push('sync');
        return { synced: 1 };
      },
      migrate: async () => {
        calls.push('migrate');
        return { migrated: 2 };
      },
      consolidate: async () => {
        calls.push('consolidate');
        return { superseded: 3 };
      },
      lifecycle: async () => {
        calls.push('lifecycle');
        return { quarantined: 4 };
      },
    },
  });

  assert.deepEqual(calls, ['sync', 'migrate', 'consolidate', 'lifecycle']);
  assert.equal(result.steps.length, 4);
});
