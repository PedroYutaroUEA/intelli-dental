import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { RetrieverTool } from '../src/agent/tools/retriever.tool';
import type { AgentContext } from '../src/agent/contracts';

function context(patientId: string): AgentContext {
  return {
    clinicId: 'clinic-1',
    userId: 'user-1',
    role: 'dentist',
    sessionId: 'session-1',
    patientId,
    permissions: ['rag:read'],
  };
}

describe('RetrieverTool patient isolation', () => {
  it('always scopes retrieval to the context patientId', async () => {
    const calls: any[] = [];
    const tool = new RetrieverTool({
      retrieve: async (req: any) => {
        calls.push(req);
        return { chunks: [], queryEcho: req.query, tookMs: 1 };
      },
    } as any);

    await tool.retrieveMany(['alergias', 'medicacoes'], context('patient-A'));

    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.filters.patientId, 'patient-A');
    }
  });

  it('does not let a different context leak another patient filter', async () => {
    const calls: any[] = [];
    const tool = new RetrieverTool({
      retrieve: async (req: any) => {
        calls.push(req);
        return { chunks: [], queryEcho: req.query, tookMs: 1 };
      },
    } as any);

    await tool.retrieveMany(['q'], context('patient-A'));
    await tool.retrieveMany(['q'], context('patient-B'));

    assert.deepEqual(
      calls.map((c) => c.filters.patientId),
      ['patient-A', 'patient-B'],
    );
  });

  it('keeps the highest-scoring chunk when the same chunkId appears across queries', async () => {
    const tool = new RetrieverTool({
      retrieve: async (req: any) => ({
        chunks: [
          {
            chunkId: 'dup',
            document: 'd',
            source: 's',
            index: 0,
            distance: req.query === 'low' ? 0.8 : 0.1,
            score: req.query === 'low' ? 0.2 : 0.9,
            metadata: {},
          },
        ],
        queryEcho: req.query,
        tookMs: 1,
      }),
    } as any);

    const result = await tool.retrieveMany(['low', 'high'], context('patient-A'));

    assert.equal(result.length, 1);
    assert.equal(result[0].score, 0.9);
  });
});
