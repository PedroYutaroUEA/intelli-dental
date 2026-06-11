import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { QueryPlannerService } from '../src/agent/planner/query-planner.service';
import type { AgentContext } from '../src/agent/contracts';

const context: AgentContext = {
  clinicId: 'clinic-1',
  userId: 'user-1',
  role: 'dentist',
  sessionId: 'session-1',
  patientId: 'patient-1',
  permissions: ['rag:read', 'patient:read', 'appointment:write'],
  locale: 'pt-BR',
};

describe('QueryPlannerService', () => {
  it('caps model-planned steps at four', async () => {
    const planner = new QueryPlannerService({
      complete: async () => ({
        text: '',
        parsedJson: {
          steps: [
            { question: 'pergunta 1' },
            { question: 'pergunta 2' },
            { question: 'pergunta 3' },
            { question: 'pergunta 4' },
            { question: 'pergunta 5' },
          ],
        },
        model: 'test',
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        fallbackModelUsed: false,
      }),
    } as any);

    const plan = await planner.plan('pergunta complexa', context);

    assert.equal(plan.strategy, 'sequential');
    assert.equal(plan.steps.length, 4);
    assert.deepEqual(
      plan.steps.map((step) => step.id),
      ['step-1', 'step-2', 'step-3', 'step-4'],
    );
  });

  it('falls back to a single-step plan on invalid model output', async () => {
    const planner = new QueryPlannerService({
      complete: async () => ({
        text: '',
        parsedJson: { steps: [{ nope: true }] },
        model: 'test',
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        fallbackModelUsed: false,
      }),
    } as any);

    const plan = await planner.plan('qual alergia?', context);

    assert.equal(plan.strategy, 'single');
    assert.deepEqual(plan.steps, [{ id: 'step-1', question: 'qual alergia?' }]);
  });
});
