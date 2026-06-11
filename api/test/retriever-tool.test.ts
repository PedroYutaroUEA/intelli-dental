import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { RetrieverTool } from '../src/agent/tools/retriever.tool';
import type { AgentContext } from '../src/agent/contracts';

const context: AgentContext = {
  clinicId: 'clinic-1',
  userId: 'user-1',
  role: 'dentist',
  sessionId: 'session-1',
  patientId: 'patient-1',
  permissions: ['rag:read'],
};

describe('RetrieverTool', () => {
  it('defaults rerank to false', async () => {
    const calls: unknown[] = [];
    const tool = new RetrieverTool({
      retrieve: async (req: unknown) => {
        calls.push(req);
        return { chunks: [], queryEcho: 'q', tookMs: 1 };
      },
    } as any);

    await tool.retrieveMany(['q'], context);

    assert.deepEqual(calls, [{ query: 'q', filters: { patientId: 'patient-1' }, rerank: false }]);
  });

  it('passes rerank true when enabled by flag', async () => {
    const calls: unknown[] = [];
    const tool = new RetrieverTool(
      {
        retrieve: async (req: unknown) => {
          calls.push(req);
          return { chunks: [], queryEcho: 'q', tookMs: 1 };
        },
      } as any,
      { enabled: () => true } as any,
    );

    await tool.retrieveMany(['q'], context);

    assert.deepEqual(calls, [{ query: 'q', filters: { patientId: 'patient-1' }, rerank: true }]);
  });
});
