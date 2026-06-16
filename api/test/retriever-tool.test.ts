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

  it('falls back to postgres chunks when rag retrieval fails', async () => {
    const fallbackChunks = [
      {
        chunkId: 'postgres:patient:patient-1',
        document: 'Telefone: 9999-9999',
        source: 'postgres:patient',
        index: 0,
        distance: 0.1,
        score: 0.9,
        metadata: { table: 'patients' },
      },
    ];
    const tool = new RetrieverTool(
      {
        retrieve: async () => {
          throw new Error('chroma unavailable');
        },
      } as any,
      undefined,
      {
        retrieveMany: async (queries: string[], ctx: AgentContext) => {
          assert.deepEqual(queries, ['telefone']);
          assert.equal(ctx.patientId, 'patient-1');
          return fallbackChunks;
        },
      } as any,
    );

    const chunks = await tool.retrieveMany(['telefone'], context);

    assert.deepEqual(chunks, fallbackChunks);
  });

  it('merges postgres chunks into the first hybrid retrieval', async () => {
    const tool = new RetrieverTool(
      {
        retrieve: async () => ({
          chunks: [
            {
              chunkId: 'vector-1',
              document: 'Documento vetorial',
              source: 'anamnesis.txt',
              index: 0,
              distance: 0.2,
              score: 0.8,
              metadata: { source: 'anamnesis.txt' },
            },
          ],
          queryEcho: 'q',
          tookMs: 1,
        }),
      } as any,
      undefined,
      {
        retrieveMany: async () => [
          {
            chunkId: 'postgres:patient:patient-1',
            document: 'Telefone: 9999-9999',
            source: 'postgres:patient',
            index: 0,
            distance: 0.1,
            score: 0.9,
            metadata: { table: 'patients' },
          },
        ],
      } as any,
    );

    const chunks = await tool.retrieveMany(['telefone'], context, { includeDatabase: true });

    assert.deepEqual(chunks.map((chunk) => chunk.chunkId), [
      'postgres:patient:patient-1',
      'vector-1',
    ]);
  });

  it('uses only postgres when databaseOnly is requested', async () => {
    let vectorCalls = 0;
    const tool = new RetrieverTool(
      {
        retrieve: async () => {
          vectorCalls += 1;
          return { chunks: [], queryEcho: 'q', tookMs: 1 };
        },
      } as any,
      undefined,
      {
        retrieveMany: async () => [
          {
            chunkId: 'postgres:patient:patient-1',
            document: 'Telefone: 9999-9999',
            source: 'postgres:patient',
            index: 0,
            distance: 0.1,
            score: 0.9,
            metadata: { table: 'patients' },
          },
        ],
      } as any,
    );

    const chunks = await tool.retrieveMany(['telefone'], context, { databaseOnly: true });

    assert.equal(vectorCalls, 0);
    assert.deepEqual(chunks.map((chunk) => chunk.chunkId), ['postgres:patient:patient-1']);
  });
});
