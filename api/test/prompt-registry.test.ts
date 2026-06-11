import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { listPrompts } from '../src/agent/prompts/registry';

describe('prompt registry', () => {
  it('registers versioned prompts for all model tasks', () => {
    const prompts = listPrompts();
    assert.deepEqual(
      prompts.map((prompt) => prompt.module).sort(),
      ['evaluate', 'generate', 'intent', 'plan', 'rewrite', 'tool_select', 'verify'],
    );
    for (const prompt of prompts) {
      assert.match(prompt.version, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(prompt.hash, /^[a-f0-9]{64}$/);
      assert.ok(prompt.body.length > 20);
    }
  });

  it('requires strict JSON instruction for control prompts', () => {
    for (const prompt of listPrompts().filter((item) => item.module !== 'generate')) {
      assert.match(prompt.body, /JSON válido/);
    }
  });
});
