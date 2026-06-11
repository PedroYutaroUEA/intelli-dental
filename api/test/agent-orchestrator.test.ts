import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentOrchestrator } from '../src/agent/orchestrator/agent-orchestrator';
import { ContextEvaluatorService } from '../src/agent/evaluators/context-evaluator.service';
import { SanitizerService } from '../src/agent/guardrails/sanitizer.service';
import { AnswerVerifierService } from '../src/agent/verifiers/answer-verifier.service';
import type { AgentContext, AgentStreamEvent } from '../src/agent/contracts';

const context: AgentContext = {
  clinicId: 'clinic-1',
  userId: 'user-1',
  role: 'dentist',
  sessionId: 'session-1',
  patientId: 'patient-1',
  permissions: ['rag:read', 'patient:read', 'appointment:write'],
  locale: 'pt-BR',
};

const flags = {
  all: () => ({
    router: true,
    queryRewrite: true,
    contextEvaluator: true,
    crag: true,
    toolCalling: true,
    verifier: true,
    debugEvents: true,
  }),
  int: (_name: string, fallback: number) => fallback,
  float: (_name: string, fallback: number) => fallback,
  enabled: (_name: string, fallback: boolean) => fallback,
};

describe('AgentOrchestrator', () => {
  it('retries weak retrieval once before falling back', async () => {
    const rewrittenInputs: string[] = [];
    const retrievedQueries: string[][] = [];
    const events: AgentStreamEvent[] = [];

    const orchestrator = new AgentOrchestrator(
      {
        appendMessage: async () => undefined,
        touchSession: async () => undefined,
      } as any,
      {} as any,
      {
        evaluate: async () => ({
          contextRelevance: 0.1,
          groundedness: 0.1,
          answerRelevance: 0.1,
          perChunk: [0.1],
        }),
      } as any,
      {
        classify: async () => ({
          intent: 'knowledge_base_search',
          confidence: 1,
          needsRetrieval: true,
          needsTool: false,
          reason: 'heuristic_default',
        }),
      } as any,
      {
        rewrite: async (question: string) => {
          rewrittenInputs.push(question);
          return { queries: [question] };
        },
      } as any,
      {
        retrieveMany: async (queries: string[]) => {
          retrievedQueries.push(queries);
          return [
            {
              chunkId: `chunk-${retrievedQueries.length}`,
              document: 'conteudo pouco relacionado',
              source: 'anamnesis.txt',
              index: retrievedQueries.length,
              distance: 0.9,
              score: 0.1,
              metadata: { source: 'anamnesis.txt', index: retrievedQueries.length },
            },
          ];
        },
      } as any,
      new ContextEvaluatorService(),
      new AnswerVerifierService(),
      new SanitizerService(),
      {
        startRun: async () => ({ id: 'run-1' }),
        recordStep: async () => undefined,
        recordTool: async () => undefined,
        finishRun: async () => undefined,
      } as any,
      flags as any,
    );

    const res = await orchestrator.run(
      {
        question: 'Qual exatamente alergia?',
        context,
        budget: {
          maxLlmCalls: 5,
          maxRetrievalAttempts: 1,
          maxWallClockMs: 15000,
        },
      },
      (event) => events.push(event),
    );

    assert.equal(res.insufficientEvidence, true);
    assert.equal(res.fallbackUsed, true);
    assert.equal(res.answer, 'Não encontrei evidências suficientes nos registros do paciente.');
    assert.equal(retrievedQueries.length, 2);
    assert.deepEqual(rewrittenInputs, ['Qual exatamente alergia?', 'alergia']);
    assert.equal(
      events.filter((event) => event.type === 'step' && event.step === 'retrieve').length,
      2,
    );
  });

  it('does not retry weak retrieval when CRAG is disabled', async () => {
    const retrievedQueries: string[][] = [];
    const orchestrator = new AgentOrchestrator(
      {
        appendMessage: async () => undefined,
        touchSession: async () => undefined,
      } as any,
      {} as any,
      {} as any,
      {
        classify: async () => ({
          intent: 'knowledge_base_search',
          confidence: 1,
          needsRetrieval: true,
          needsTool: false,
          reason: 'heuristic_default',
        }),
      } as any,
      {
        rewrite: async (question: string) => ({ queries: [question] }),
      } as any,
      {
        retrieveMany: async (queries: string[]) => {
          retrievedQueries.push(queries);
          return [
            {
              chunkId: 'chunk-1',
              document: 'conteudo pouco relacionado',
              source: 'anamnesis.txt',
              index: 1,
              distance: 0.9,
              score: 0.1,
              metadata: { source: 'anamnesis.txt', index: 1 },
            },
          ];
        },
      } as any,
      new ContextEvaluatorService(),
      new AnswerVerifierService(),
      new SanitizerService(),
      {
        startRun: async () => ({ id: 'run-1' }),
        recordStep: async () => undefined,
        recordTool: async () => undefined,
        finishRun: async () => undefined,
      } as any,
      {
        ...flags,
        all: () => ({ ...flags.all(), crag: false }),
      } as any,
    );

    const res = await orchestrator.run(
      {
        question: 'Qual exatamente alergia?',
        context,
        budget: {
          maxLlmCalls: 5,
          maxRetrievalAttempts: 3,
          maxWallClockMs: 15000,
        },
      },
      () => undefined,
    );

    assert.equal(res.insufficientEvidence, true);
    assert.equal(retrievedQueries.length, 1);
  });

  it('runs a multi-step clinical flow with CRAG retry on the weak step', async () => {
    const rewrittenInputs: string[] = [];
    const retrievedQueries: string[][] = [];
    const events: AgentStreamEvent[] = [];
    const evaluations = [
      { sufficient: true, score: 0.8, missing: [], method: 'cosine' as const },
      {
        sufficient: false,
        score: 0.55,
        missing: ['recomendação final explícita'],
        suggestedQuery: 'recomendação final pós-raspagem manutenção periodontal',
        method: 'llm' as const,
      },
      { sufficient: true, score: 0.82, missing: [], method: 'cosine' as const },
    ];

    const orchestrator = new AgentOrchestrator(
      {
        appendMessage: async () => undefined,
        touchSession: async () => undefined,
      } as any,
      {} as any,
      {
        evaluate: async () => ({
          contextRelevance: 0.88,
          groundedness: 0.88,
          answerRelevance: 0.9,
          perChunk: [0.8, 0.83],
        }),
      } as any,
      {
        classify: async () => ({
          intent: 'multi_step_question',
          confidence: 0.86,
          needsRetrieval: true,
          needsTool: false,
          reason: 'two sub-questions',
        }),
      } as any,
      {
        rewrite: async (question: string) => {
          rewrittenInputs.push(question);
          if (question.includes('recorrentes')) {
            return { queries: ['problemas recorrentes de gengiva'] };
          }
          if (question.includes('pós-raspagem')) {
            return { queries: ['recomendação final pós-raspagem manutenção periodontal'] };
          }
          return { queries: ['recomendação final tratamento gengival'] };
        },
      } as any,
      {
        retrieveMany: async (queries: string[]) => {
          retrievedQueries.push(queries);
          if (queries[0].includes('recorrentes')) {
            return [
              {
                chunkId: 'anamnesis.txt#3',
                document: 'Queixa de sangramento gengival recorrente há 8 meses.',
                source: 'anamnesis.txt',
                index: 3,
                distance: 0.19,
                score: 0.81,
                metadata: { source: 'anamnesis.txt', index: 3 },
              },
            ];
          }
          if (queries[0].includes('pós-raspagem')) {
            return [
              {
                chunkId: 'consulta-2025-06.pdf#1',
                document: 'Conclusão: alta da fase ativa; manutenção periodontal trimestral.',
                source: 'consulta-2025-06.pdf',
                index: 1,
                distance: 0.17,
                score: 0.83,
                metadata: { source: 'consulta-2025-06.pdf', index: 1 },
              },
            ];
          }
          return [
            {
              chunkId: 'plano-tratamento.json#0',
              document: 'Recomendação: raspagem e alisamento radicular.',
              source: 'plano-tratamento.json',
              index: 0,
              distance: 0.26,
              score: 0.74,
              metadata: { source: 'plano-tratamento.json', index: 0 },
            },
          ];
        },
      } as any,
      {
        evaluate: async () => evaluations.shift(),
      } as any,
      {
        verify: async () => ({
          faithful: true,
          groundedness: 0.88,
          citationsOk: true,
          unsupportedClaims: [],
          action: 'pass',
          method: 'hybrid',
        }),
      } as any,
      new SanitizerService(),
      {
        startRun: async () => ({ id: 'run-88' }),
        recordStep: async () => undefined,
        recordTool: async () => undefined,
        finishRun: async () => undefined,
      } as any,
      flags as any,
      {
        plan: async () => ({
          strategy: 'sequential',
          steps: [
            {
              id: 's1',
              question: 'Documentos que indicam problemas recorrentes de gengiva',
            },
            {
              id: 's2',
              question: 'Recomendação final registrada para o quadro gengival',
              dependsOn: ['s1'],
            },
          ],
        }),
      } as any,
      {
        generate: async (_question: string, _chunks: unknown, _ctx: unknown, emit: (event: AgentStreamEvent) => void) => {
          const text =
            'Os registros indicam recorrência na anamnese e a recomendação final foi manutenção periodontal trimestral.';
          emit({ type: 'token', token: text });
          return { text, citations: [] };
        },
      } as any,
    );

    const res = await orchestrator.run(
      {
        question:
          'Quais documentos indicam que o paciente teve problemas recorrentes de gengiva, e qual foi a recomendação final?',
        context,
        budget: {
          maxLlmCalls: 6,
          maxRetrievalAttempts: 1,
          maxWallClockMs: 15000,
        },
      },
      (event) => events.push(event),
    );

    assert.equal(res.fallbackUsed, false);
    assert.equal(res.insufficientEvidence, false);
    assert.equal(res.intent, 'multi_step_question');
    assert.equal(res.verification.action, 'pass');
    assert.equal(retrievedQueries.length, 3);
    assert.deepEqual(rewrittenInputs, [
      'Documentos que indicam problemas recorrentes de gengiva',
      'Recomendação final registrada para o quadro gengival',
      'recomendação final pós-raspagem manutenção periodontal',
    ]);
    assert.deepEqual(
      res.citations.map((citation) => citation.chunkId),
      ['consulta-2025-06.pdf#1', 'anamnesis.txt#3'],
    );
    assert.equal(events.some((event) => event.type === 'sources'), true);
    assert.equal(events.some((event) => event.type === 'metrics'), true);
  });
});
