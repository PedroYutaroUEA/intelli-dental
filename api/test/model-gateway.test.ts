import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ModelGatewayService } from '../src/models/model-gateway.service';
import type { ModelMessage } from '../src/agent/contracts';

class MockConfig {
  constructor(private readonly values: Record<string, string | undefined> = {}) {}
  get<T = string>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }
}

class MockOllama {
  calls: Array<{ model: string; messages: ModelMessage[]; temperature?: number; numPredict?: number }> = [];
  queue: Array<unknown> = [];

  async chat(body: any) {
    this.calls.push({
      model: body.model,
      messages: body.messages,
      temperature: body.options?.temperature,
      numPredict: body.options?.num_predict,
    });
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return next ?? { text: '{}', promptEvalCount: 1, evalCount: 2 };
  }

  async warmup() {
    return undefined;
  }
}

describe('ModelGatewayService', () => {
  it('routes task model env vars and honors modelOverride', async () => {
    const ollama = new MockOllama();
    ollama.queue.push({ text: '{"ok":true}', promptEvalCount: 3, evalCount: 4 });
    const gateway = new ModelGatewayService(
      new MockConfig({ AGENT_PLAN_MODEL: 'llama3.2:3b', AGENT_LLM_MODEL: 'phi3:mini' }) as any,
      ollama as any,
    );

    const res = await gateway.complete({
      task: 'plan',
      json: true,
      modelOverride: 'custom:model',
      messages: [{ role: 'user', content: 'plan' }],
    });

    assert.equal(ollama.calls[0]?.model, 'custom:model');
    assert.equal(res.model, 'custom:model');
    assert.deepEqual(res.parsedJson, { ok: true });
  });

  it('uses generate temperature default', async () => {
    const ollama = new MockOllama();
    ollama.queue.push({ text: 'answer', promptEvalCount: 1, evalCount: 5 });
    const gateway = new ModelGatewayService(new MockConfig({ AGENT_LLM_MODEL: 'phi3:mini' }) as any, ollama as any);

    await gateway.complete({
      task: 'generate',
      messages: [{ role: 'user', content: 'answer' }],
    });

    assert.equal(ollama.calls[0]?.temperature, 0.2);
    assert.equal(ollama.calls[0]?.numPredict, 512);
  });

  it('retries invalid JSON once with a stricter instruction', async () => {
    const ollama = new MockOllama();
    ollama.queue.push(
      { text: 'not json', promptEvalCount: 1, evalCount: 1 },
      { text: '{"ok":true}', promptEvalCount: 2, evalCount: 2 },
    );
    const gateway = new ModelGatewayService(new MockConfig({ AGENT_LLM_MODEL: 'phi3:mini' }) as any, ollama as any);

    const res = await gateway.complete({
      task: 'intent',
      json: true,
      messages: [{ role: 'user', content: 'intent' }],
    });

    assert.equal(ollama.calls.length, 2);
    assert.match(ollama.calls[1]?.messages.at(-1)?.content ?? '', /JSON válido/);
    assert.deepEqual(res.parsedJson, { ok: true });
  });

  it('falls back from plan model to default model', async () => {
    const ollama = new MockOllama();
    ollama.queue.push(new Error('missing model'), { text: '{"steps":[]}', promptEvalCount: 1, evalCount: 1 });
    const gateway = new ModelGatewayService(
      new MockConfig({ AGENT_PLAN_MODEL: 'llama3.2:3b', AGENT_LLM_MODEL: 'phi3:mini' }) as any,
      ollama as any,
    );

    const res = await gateway.complete({
      task: 'plan',
      json: true,
      messages: [{ role: 'user', content: 'plan' }],
    });

    assert.equal(ollama.calls[0]?.model, 'llama3.2:3b');
    assert.equal(ollama.calls[1]?.model, 'phi3:mini');
    assert.equal(res.fallbackModelUsed, true);
  });
});
