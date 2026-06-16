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
  it('routes dentist availability questions to the tool path', async () => {
    let llmCalls = 0;
    const router = new IntentRouterService(
      {
        complete: async () => {
          llmCalls += 1;
          return {
            text: '{}',
            parsedJson: {},
            model: 'phi3:mini',
            tokensIn: 0,
            tokensOut: 0,
            latencyMs: 0,
            fallbackModelUsed: false,
          };
        },
      } as any,
      new HeuristicRouter(),
    );

    const result = await router.classify('Quais dentistas estão disponíveis na clínica?', context);

    assert.equal(result.intent, 'action_request');
    assert.equal(result.reason, 'heuristic_dentist_list');
    assert.equal(result.needsTool, true);
    assert.equal(result.needsRetrieval, false);
    assert.equal(llmCalls, 0);
  });

  it('routes natural-language appointment scheduling to action_request before RAG', async () => {
    let llmCalls = 0;
    const router = new IntentRouterService(
      {
        complete: async () => {
          llmCalls += 1;
          return {
            text: '{}',
            parsedJson: {},
            model: 'phi3:mini',
            tokensIn: 0,
            tokensOut: 0,
            latencyMs: 0,
            fallbackModelUsed: false,
          };
        },
      } as any,
      new HeuristicRouter(),
    );

    const result = await router.classify(
      'Agende uma consulta com o dr Wanderberg em 2026-06-20 as 11:00 por 30 minutos para limpeza',
      context,
    );

    assert.equal(result.intent, 'action_request');
    assert.equal(result.reason, 'heuristic_action_request');
    assert.equal(result.needsTool, true);
    assert.equal(result.needsRetrieval, false);
    assert.equal(llmCalls, 0);
  });

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
      'Preciso organizar um atendimento amanhã às 14h',
      context,
    );

    assert.equal(result.intent, 'action_request');
    assert.equal(result.needsTool, true);
    assert.equal(result.needsRetrieval, false);
    assert.equal(result.action, undefined);
    assert.equal(result.modelUsage?.model, 'phi3:mini');
  });
});
