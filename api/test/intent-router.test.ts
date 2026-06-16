import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { AgentContext } from '../src/agent/contracts';
import { HeuristicRouter } from '../src/agent/router/heuristic-router';
import { IntentRouterService } from '../src/agent/router/intent-router.service';

const context: AgentContext = {
  clinicId: 'clinic-1',
  userId: 'user-1',
  role: 'dentist',
  sessionId: 'session-1',
  patientId: 'patient-1',
  permissions: ['rag:read', 'appointment:write'],
  locale: 'pt-BR',
};

describe('IntentRouterService', () => {
  it('accepts model-classified action requests for natural-language tools', async () => {
    const router = new IntentRouterService(
      {
        complete: async () => ({
          text: '{"intent":"action_request"}',
          parsedJson: {
            intent: 'action_request',
            confidence: 0.9,
            needsRetrieval: false,
            needsTool: true,
            reason: 'appointment creation',
          },
          model: 'phi3:mini',
          tokensIn: 10,
          tokensOut: 4,
          latencyMs: 20,
          fallbackModelUsed: false,
        }),
      } as any,
      new HeuristicRouter(),
    );

    const result = await router.classify(
      'Crie uma consulta com o dentista amanhã às 14h',
      context,
    );

    assert.equal(result.intent, 'action_request');
    assert.equal(result.needsTool, true);
    assert.equal(result.needsRetrieval, false);
    assert.equal(result.action, undefined);
    assert.equal(result.modelUsage?.model, 'phi3:mini');
  });
});
