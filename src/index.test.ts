import assert from 'node:assert/strict';
import test from 'node:test';

import register from './index';

test('register installs auto-recall hook when enabled and hook api exists', async () => {
  const hooks: Array<{ name: string; handler: Function }> = [];
  const tools: string[] = [];

  register({
    pluginConfig: {
      autoRecall: { enabled: true, topK: 3, maxChars: 300, scope: 'all' },
    },
    registerTool(tool: any) {
      tools.push(tool.name);
    },
    registerHook(name: string, handler: Function) {
      hooks.push({ name, handler });
    },
  } as any);

  assert.ok(tools.includes('memory_search'));
  assert.ok(hooks.some((hook) => hook.name === 'agent_start'));
});

test('register does not throw when auto-recall is enabled but no hook api exists', async () => {
  assert.doesNotThrow(() => {
    register({
      pluginConfig: {
        autoRecall: { enabled: true, topK: 3, maxChars: 300, scope: 'all' },
      },
      registerTool() {},
    } as any);
  });
});
