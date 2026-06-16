import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AnswerGeneratorService } from '../src/agent/generators/answer-generator.service';
import type { AgentContext, RetrievedChunk } from '../src/agent/contracts';

const context: AgentContext = {
  clinicId: 'clinic-1',
  userId: 'user-1',
  role: 'dentist',
  sessionId: 'session-1',
  patientId: 'patient-1',
  permissions: ['rag:read'],
};

const evidence: RetrievedChunk[] = [
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

describe('AnswerGeneratorService', () => {
  it('falls back to model gateway when rag generate fails', async () => {
    const generator = new AnswerGeneratorService(
      {
        openGenerateStream: async () => {
          throw new Error('rag pipeline unavailable');
        },
      } as any,
      {
        complete: async (req: any) => {
          assert.equal(req.task, 'generate');
          assert.match(req.messages[1].content, /Telefone: 9999-9999/);
          return {
            text: 'Telefone: 9999-9999 [postgres:patient#0]',
            parsedJson: undefined,
            model: 'test',
            tokensIn: 1,
            tokensOut: 1,
            latencyMs: 1,
            fallbackModelUsed: false,
          };
        },
      } as any,
    );

    const emitted: string[] = [];
    const result = await generator.generate('qual telefone?', evidence, context, (event) => {
      if (event.type === 'token') emitted.push(event.token);
    });

    assert.equal(result.text, 'Telefone: 9999-9999 [postgres:patient#0]');
    assert.deepEqual(emitted, ['Telefone: 9999-9999 [postgres:patient#0]']);
    assert.equal(result.citations[0]?.source, 'postgres:patient');
    assert.equal(result.modelUsage?.model, 'test');
    assert.equal(result.modelUsage?.tokensIn, 1);
    assert.equal(result.modelUsage?.tokensOut, 1);
  });
});
