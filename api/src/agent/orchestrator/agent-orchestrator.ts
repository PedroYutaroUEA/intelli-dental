import { Injectable, Logger, Optional } from '@nestjs/common';
import { ChatService } from '../../chat/chat.service';
import { RagService, type RagMetrics } from '../../rag/rag.service';
import { AgentFeatureFlagsService, type AgentFeatureFlags } from '../config/agent-feature-flags.service';
import type {
  AgentRequest,
  AgentResponse,
  AgentStreamEvent,
  Citation,
  ContextEvaluation,
  RetrievedChunk,
  VerificationResult,
  ModelUsage,
} from '../contracts';
import { ContextEvaluatorService } from '../evaluators/context-evaluator.service';
import { AnswerGeneratorService } from '../generators/answer-generator.service';
import { SanitizerService } from '../guardrails/sanitizer.service';
import { MemoryService } from '../memory/memory.service';
import { QueryPlannerService } from '../planner/query-planner.service';
import { QueryRewriterService } from '../planner/query-rewriter.service';
import { IntentRouterService } from '../router/intent-router.service';
import { AgentTracingService } from '../tracing/agent-tracing.service';
import { RetrieverTool } from '../tools/retriever.tool';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { AnswerVerifierService } from '../verifiers/answer-verifier.service';
import { BudgetExceededError } from '../errors';

const INSUFFICIENT_EVIDENCE =
  'Não encontrei evidências suficientes nos registros do paciente.';

export interface ParsedSseEvent {
  event?: string;
  data: string;
}

@Injectable()
export class AgentOrchestrator {
  private readonly logger = new Logger(AgentOrchestrator.name);

  constructor(
    private readonly chat: ChatService,
    private readonly tools: ToolRegistryService,
    private readonly rag: RagService,
    private readonly router: IntentRouterService,
    private readonly rewriter: QueryRewriterService,
    private readonly retriever: RetrieverTool,
    private readonly evaluator: ContextEvaluatorService,
    private readonly verifier: AnswerVerifierService,
    private readonly sanitizer: SanitizerService,
    private readonly tracing: AgentTracingService,
    private readonly flags: AgentFeatureFlagsService,
    @Optional() private readonly planner?: QueryPlannerService,
    @Optional() private readonly generator?: AnswerGeneratorService,
    @Optional() private readonly memory?: MemoryService,
  ) {}

  async run(
    req: AgentRequest,
    emit: (ev: AgentStreamEvent) => void,
  ): Promise<AgentResponse> {
    const startedAt = Date.now();
    let seq = 0;
    let intent = 'knowledge_base_search';
    let fallbackUsed = false;
    let insufficientEvidence = false;
    let assistantText = '';
    let llmCalls = 0;
    let metrics: RagMetrics | null = null;
    let sources: ReturnType<AgentOrchestrator['toSources']> = [];
    const featureFlags = this.flags.all();
    const emitStep = (step: AgentStreamEvent & { type: 'step' }) => {
      if (featureFlags.debugEvents) emit(step);
    };
    let verification: VerificationResult = {
      faithful: false,
      groundedness: 0,
      citationsOk: false,
      unsupportedClaims: [],
      action: 'downgrade',
      method: 'cosine',
    };

    const question = this.sanitizer.sanitizeQuestion(req.question);
    await this.chat.appendMessage(req.context.sessionId, 'user', question);
    const run = await this.tracing.startRun(req.context, question);
    const ctx = { ...req.context, agentRunId: run.id };

    const record = async (
      type: Parameters<AgentTracingService['recordStep']>[0]['type'],
      stepStartedAt: number,
      output?: unknown,
      input?: unknown,
      error?: { code: string; message: string },
    ) => {
      const modelUsage = this.modelUsageFrom(output);
      return await this.tracing.recordStep({
        runId: run.id,
        seq: ++seq,
        type,
        startedAt: stepStartedAt,
        model: modelUsage?.model,
        tokensIn: modelUsage?.tokensIn,
        tokensOut: modelUsage?.tokensOut,
        input,
        output,
        error,
      });
    };

    try {
      this.assertBudget(startedAt, req.budget);

      const intentStartedAt = Date.now();
      emitStep({ type: 'step', step: 'intent' });
      const route = req.mode === 'simple'
        ? {
            intent: 'knowledge_base_search' as const,
            confidence: 1,
            needsRetrieval: true,
            needsTool: false,
            reason: 'simple_mode',
          }
        : await this.classify(question, ctx, featureFlags);
      intent = route.intent;
      await record('intent', intentStartedAt, route, { question });
      emitStep({ type: 'step', step: 'intent', data: route });
      if (
        route.reason !== 'simple_mode' &&
        route.reason !== 'local_command' &&
        route.reason !== 'slash_command' &&
        route.reason !== 'heuristic_default'
      ) {
        llmCalls += 1;
      }

      if (route.intent === 'unsupported') {
        fallbackUsed = true;
        insufficientEvidence = true;
        assistantText = INSUFFICIENT_EVIDENCE;
        emit({ type: 'token', token: assistantText });
        await record('fallback', Date.now(), { reason: route.reason });
        return await this.finish({
          runId: run.id,
          sessionId: ctx.sessionId,
          question,
          answer: assistantText,
          intent,
          citations: [],
          verification,
          fallbackUsed,
          insufficientEvidence,
          metrics,
          startedAt,
        });
      }

      if (route.intent === 'direct_answer') {
        assistantText =
          route.localMessage ??
          'Posso ajudar com perguntas sobre os registros do paciente selecionado.';
        emit({ type: 'token', token: assistantText });
        verification = {
          faithful: true,
          groundedness: 1,
          citationsOk: true,
          unsupportedClaims: [],
          action: 'pass',
          method: 'cosine',
        };
        return await this.finish({
          runId: run.id,
          sessionId: ctx.sessionId,
          question,
          answer: assistantText,
          intent,
          citations: [],
          verification,
          fallbackUsed,
          insufficientEvidence,
          metrics,
          startedAt,
        });
      }

      if (route.intent === 'action_request') {
        if (!featureFlags.toolCalling) {
          fallbackUsed = true;
          assistantText = 'Ações por ferramenta estão desabilitadas no momento.';
          emit({ type: 'token', token: assistantText });
          await record('fallback', Date.now(), { reason: 'tool_calling_disabled' });
          return await this.finish({
            runId: run.id,
            sessionId: ctx.sessionId,
            question,
            answer: assistantText,
            intent,
            citations: [],
            verification,
            fallbackUsed,
            insufficientEvidence,
            metrics,
            startedAt,
          });
        }
        const action = route.action;
        if (!action) throw new Error('Action route missing action payload');
        const toolStartedAt = Date.now();
        emitStep({ type: 'step', step: 'tool', data: { kind: action.kind, mode: action.mode } });
        const { call: toolCall, result } = await this.tools.execute(
          ctx,
          action,
          !!req.confirm,
          req.idempotencyKey,
        );
        await this.tracing.recordTool(run.id, { ...toolCall, id: `${run.id}:${action.kind}` }, {
          ok: true,
          data: result.data,
          mutated: result.mutated,
        });
        await record('tool', toolStartedAt, { kind: action.kind, mode: action.mode });
        assistantText = result.message;
        emit({ type: 'token', token: assistantText });
        if (result.render) {
          emit({
            type: 'preview',
            toolCall: { ...toolCall, id: `${run.id}:${action.kind}`, mode: 'commit' },
            render: result.render,
          });
        }
        verification = {
          faithful: true,
          groundedness: 1,
          citationsOk: true,
          unsupportedClaims: [],
          action: 'pass',
          method: 'cosine',
        };
        return await this.finish({
          runId: run.id,
          sessionId: ctx.sessionId,
          question,
          answer: assistantText,
          intent,
          citations: [],
          verification,
          fallbackUsed,
          insufficientEvidence,
          metrics,
          startedAt,
          updateMemory: !result.render,
        });
      }

      const planStartedAt = Date.now();
      emitStep({ type: 'step', step: 'plan' });
      const plan = route.intent === 'multi_step_question' && this.planner
        ? await this.planner.plan(question, ctx)
        : QueryPlannerService.singleStep(question);
      if (route.intent === 'multi_step_question' && this.planner) llmCalls += 1;
      await record('plan', planStartedAt, plan, { question, intent: route.intent });
      emitStep({ type: 'step', step: 'plan', data: plan });

      let chunks: RetrievedChunk[] = [];
      const evidence: RetrievedChunk[] = [];
      let context: ContextEvaluation = this.defaultContextEvaluation();
      const maxAttempts = featureFlags.crag ? 1 + Math.max(0, req.budget.maxRetrievalAttempts) : 1;

      for (const step of plan.steps) {
        let retryQuery = step.question;
        const seenQuerySets = new Set<string>();
        let stepSucceeded = false;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          this.assertBudget(startedAt, req.budget);
          this.assertLlmBudget(llmCalls, req.budget);

          const rewriteStartedAt = Date.now();
          emitStep({ type: 'step', step: 'rewrite', data: { attempt, planStep: step.id } });
          const rewrite = featureFlags.queryRewrite
            ? await this.rewrite(retryQuery, ctx)
            : { queries: [retryQuery] };
          if (featureFlags.queryRewrite) llmCalls += 1;
          await record('rewrite', rewriteStartedAt, rewrite, {
            question: retryQuery,
            attempt,
            planStep: step.id,
          });
          emitStep({ type: 'step', step: 'rewrite', data: { ...rewrite, attempt, planStep: step.id } });

          const queryKey = this.queryKey(rewrite.queries);
          if (seenQuerySets.has(queryKey)) {
            await record('fallback', Date.now(), {
              reason: 'duplicate_retry_queries',
              attempt,
              queries: rewrite.queries,
              planStep: step.id,
            });
            break;
          }
          seenQuerySets.add(queryKey);

          this.assertBudget(startedAt, req.budget);
          const retrieveStartedAt = Date.now();
          const retrievalMode = attempt === 1 ? 'hybrid' : 'database_only';
          emitStep({
            type: 'step',
            step: 'retrieve',
            data: { attempt, queries: rewrite.queries, planStep: step.id, retriever: retrievalMode },
          });
          chunks = this.sanitizer.sanitizeChunks(
            await this.retriever.retrieveMany(rewrite.queries, ctx, {
              includeDatabase: retrievalMode === 'hybrid',
              databaseOnly: retrievalMode === 'database_only',
            }),
          );
          const hasDatabaseChunks = chunks.some((chunk) => chunk.source.startsWith('postgres:'));
          const retrieveStep = await record('retrieve', retrieveStartedAt, {
            attempt,
            planStep: step.id,
            retriever: retrievalMode,
            databaseQueries: hasDatabaseChunks ? rewrite.queries : undefined,
            count: chunks.length,
            chunks: chunks.map((chunk) => ({
              chunkId: chunk.chunkId,
              source: chunk.source,
              index: chunk.index,
              score: chunk.score,
              distance: chunk.distance,
            })),
          }, {
            attempt,
            planStep: step.id,
            queries: rewrite.queries,
            retriever: retrievalMode,
            databaseQueries: retrievalMode === 'database_only' || retrievalMode === 'hybrid'
              ? rewrite.queries
              : undefined,
          });
          await this.tracing.recordRetrievedChunks?.(run.id, retrieveStep?.id, chunks);

          sources = this.toSources(chunks);

          const evaluateStartedAt = Date.now();
          emitStep({ type: 'step', step: 'evaluate', data: { attempt, planStep: step.id } });
          context = featureFlags.contextEvaluator
            ? await this.evaluateContext(step.question, chunks)
            : { sufficient: chunks.length > 0, score: chunks[0]?.score ?? 0, missing: [], method: 'cosine' };
          await record('evaluate', evaluateStartedAt, { ...context, attempt, planStep: step.id });
          await this.tracing.recordContextEvaluation?.(run.id, context);
          emitStep({ type: 'step', step: 'evaluate', data: { ...context, attempt, planStep: step.id } });
          if (context.sufficient) {
            evidence.push(...chunks);
            stepSucceeded = true;
            break;
          }
          if (attempt >= maxAttempts) break;

          retryQuery = context.suggestedQuery && context.suggestedQuery.length > 0
            ? context.suggestedQuery
            : step.question;
        }

        if (!stepSucceeded && plan.steps.length === 1) break;
      }

      chunks = this.dedupeChunks(evidence);
      sources = this.toSources(chunks);
      const hasSufficientContext = plan.steps.length === 1 ? context.sufficient : chunks.length > 0;
      const memoryContext = this.memory?.buildMemoryContext(
        await this.memory?.getSessionMemory(ctx.sessionId) ?? null,
      );

      if (sources.length > 0) emit({ type: 'sources', sources });
      if (!hasSufficientContext) {
        fallbackUsed = true;
        insufficientEvidence = true;
        assistantText = INSUFFICIENT_EVIDENCE;
        emit({ type: 'token', token: assistantText });
        await record('fallback', Date.now(), {
          reason: 'insufficient_context',
          score: context.score,
          missing: context.missing,
        });
      } else {
        this.assertBudget(startedAt, req.budget);
        this.assertLlmBudget(llmCalls, req.budget);
        emitStep({ type: 'step', step: 'generate' });
        const generateStartedAt = Date.now();
        const generationQuestion = this.withMemory(question, memoryContext);
        let generationModelUsage: ModelUsage | undefined;
        if (this.generator) {
          const generated = await this.generator.generate(generationQuestion, chunks, ctx, emit);
          assistantText = generated.text;
          generationModelUsage = generated.modelUsage;
        } else {
          assistantText = await this.generate(ctx.patientId, generationQuestion, chunks, emit);
        }
        llmCalls += 1;
        await record('generate', generateStartedAt, {
          chars: assistantText.length,
          modelUsage: generationModelUsage,
          provider: generationModelUsage ? 'model_gateway' : 'rag_pipeline',
        });
        if (assistantText.trim().length > 0) {
          try {
            metrics = await this.rag.evaluate({
              question,
              answer: assistantText,
              chunks: chunks.map((chunk) => ({
                chunkId: chunk.chunkId,
                document: chunk.document,
                source: chunk.source,
                index: chunk.index,
                score: chunk.score,
                metadata: chunk.metadata as Record<string, string | number | boolean>,
                distance: chunk.distance,
              })),
            });
            emit({ type: 'metrics', metrics });
          } catch (err) {
            this.logger.warn(`metrics failed: ${(err as Error).message}`);
          }
        }
        emitStep({ type: 'step', step: 'verify' });
        verification = featureFlags.verifier
          ? await this.verifyAnswer(assistantText, chunks, metrics?.groundedness ?? null)
          : {
              faithful: true,
              groundedness: metrics?.groundedness ?? chunks[0]?.score ?? 0,
              citationsOk: true,
              unsupportedClaims: [],
              action: 'pass',
              method: 'cosine',
            };
        await record('verify', Date.now(), verification);
        await this.tracing.recordVerification?.(run.id, verification);
        emitStep({ type: 'step', step: 'verify', data: verification });
        if (verification.action === 'downgrade') {
          fallbackUsed = true;
          insufficientEvidence = true;
          assistantText = INSUFFICIENT_EVIDENCE;
        }
      }

      const citations = this.toCitations(chunks);
      return await this.finish({
        runId: run.id,
        sessionId: ctx.sessionId,
        question,
        answer: assistantText,
        intent,
        citations: insufficientEvidence ? [] : citations,
        verification,
        fallbackUsed,
        insufficientEvidence,
        metrics,
        startedAt,
        sources: insufficientEvidence ? undefined : sources,
      });
    } catch (err) {
      const message = (err as Error).message;
      fallbackUsed = true;
      try {
        const legacy = await this.legacyRagFallback(ctx.patientId, question, emit);
        assistantText = legacy.answer;
        metrics = legacy.metrics;
        sources = legacy.sources;
        verification = {
          faithful: true,
          groundedness: metrics?.groundedness ?? 0,
          citationsOk: true,
          unsupportedClaims: [],
          action: 'pass',
          method: 'cosine',
        };
        await record('fallback', Date.now(), { reason: 'legacy_rag', error: message });
        return await this.finish({
          runId: run.id,
          sessionId: ctx.sessionId,
          question,
          answer: assistantText,
          intent,
          citations: [],
          verification,
          fallbackUsed,
          insufficientEvidence,
          metrics,
          startedAt,
          sources,
        });
      } catch (fallbackErr) {
        this.logger.warn(`legacy fallback failed: ${(fallbackErr as Error).message}`);
      }
      await record('error', Date.now(), undefined, undefined, {
        code: 'agent_failed',
        message,
      });
      await this.tracing.finishRun({
        runId: run.id,
        intent,
        fallbackUsed,
        insufficientEvidence,
        totalLatencyMs: Date.now() - startedAt,
        error: { code: 'agent_failed', message },
      });
      throw err;
    }
  }

  private async classify(
    question: string,
    ctx: AgentRequest['context'],
    flags: AgentFeatureFlags,
  ) {
    if (!flags.router) {
      return {
        intent: 'knowledge_base_search' as const,
        confidence: 1,
        needsRetrieval: true,
        needsTool: false,
        reason: 'router_disabled',
      };
    }
    try {
      return await this.router.classify(question, ctx);
    } catch (err) {
      this.logger.warn(`router fallback: ${(err as Error).message}`);
      return {
        intent: 'knowledge_base_search' as const,
        confidence: 0.7,
        needsRetrieval: true,
        needsTool: false,
        reason: 'router_failed',
      };
    }
  }

  private async rewrite(question: string, ctx: AgentRequest['context']) {
    try {
      return await this.rewriter.rewrite(question, ctx);
    } catch (err) {
      this.logger.warn(`rewrite fallback: ${(err as Error).message}`);
      return { queries: [question] };
    }
  }

  private async evaluateContext(question: string, chunks: RetrievedChunk[]) {
    try {
      return await this.evaluator.evaluate(question, chunks);
    } catch (err) {
      this.logger.warn(`context evaluator fallback: ${(err as Error).message}`);
      return {
        sufficient: chunks.length > 0,
        score: chunks[0]?.score ?? 0,
        missing: chunks.length > 0 ? [] : ['no_context'],
        method: 'cosine' as const,
      };
    }
  }

  private async verifyAnswer(
    answer: string,
    chunks: RetrievedChunk[],
    groundedness?: number | null,
  ) {
    try {
      return await this.verifier.verify(answer, chunks, groundedness);
    } catch (err) {
      this.logger.warn(`verifier fallback: ${(err as Error).message}`);
      return {
        faithful: true,
        groundedness: groundedness ?? chunks[0]?.score ?? 0,
        citationsOk: true,
        unsupportedClaims: [],
        action: 'pass' as const,
        method: 'cosine' as const,
      };
    }
  }

  private defaultContextEvaluation() {
    return {
      sufficient: false,
      score: 0,
      missing: ['no_context'],
      method: 'cosine' as const,
    };
  }

  private modelUsageFrom(output: unknown): ModelUsage | undefined {
    if (!output || typeof output !== 'object') return undefined;
    const usage = (output as { modelUsage?: unknown }).modelUsage;
    if (!usage || typeof usage !== 'object') return undefined;
    const modelUsage = usage as Partial<ModelUsage>;
    if (typeof modelUsage.model !== 'string') return undefined;
    return {
      model: modelUsage.model,
      tokensIn: typeof modelUsage.tokensIn === 'number' ? modelUsage.tokensIn : 0,
      tokensOut: typeof modelUsage.tokensOut === 'number' ? modelUsage.tokensOut : 0,
      latencyMs: typeof modelUsage.latencyMs === 'number' ? modelUsage.latencyMs : 0,
      fallbackModelUsed: modelUsage.fallbackModelUsed === true,
    };
  }

  parseSseEvent(raw: string): ParsedSseEvent | null {
    if (this.generator) return this.generator.parseSseEvent(raw);
    const lines = raw.split('\n');
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join('\n') };
  }

  extractAssistantText(parsed: ParsedSseEvent): string {
    if (this.generator) return this.generator.extractAssistantText(parsed);
    if (parsed.event === 'token' || parsed.event === 'message') {
      try {
        const obj = JSON.parse(parsed.data) as { token?: string; content?: string };
        return obj.token ?? obj.content ?? '';
      } catch {
        return parsed.data;
      }
    }
    if (!parsed.event) {
      try {
        const value = JSON.parse(parsed.data);
        return typeof value === 'string' ? value : parsed.data;
      } catch {
        return parsed.data;
      }
    }
    return '';
  }

  private async generate(
    patientId: string,
    question: string,
    chunks: RetrievedChunk[],
    emit: (ev: AgentStreamEvent) => void,
  ): Promise<string> {
    let answer = '';
    const upstream = await this.rag.openGenerateStream({
      patientId,
      question,
      chunks: chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        document: chunk.document,
        source: chunk.source,
        index: chunk.index,
        score: chunk.score,
        metadata: chunk.metadata as Record<string, string | number | boolean>,
        distance: chunk.distance,
      })),
    });
    let buffer = '';
    for await (const chunk of upstream as AsyncIterable<Buffer | string>) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const evt = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = this.parseSseEvent(evt);
        if (!parsed || parsed.event === 'done') continue;
        if (parsed.event === 'error') throw new Error(parsed.data);
        const token = this.extractAssistantText(parsed);
        if (token.length > 0) {
          answer += token;
          emit({ type: 'token', token });
        }
      }
    }
    return answer;
  }

  private async legacyRagFallback(
    patientId: string,
    question: string,
    emit: (ev: AgentStreamEvent) => void,
  ): Promise<{
    answer: string;
    sources: ReturnType<AgentOrchestrator['toSources']>;
    metrics: RagMetrics | null;
  }> {
    let answer = '';
    let sources: ReturnType<AgentOrchestrator['toSources']> = [];
    let metrics: RagMetrics | null = null;
    const upstream = await this.rag.openChatStream({ patientId, question });
    let buffer = '';
    for await (const chunk of upstream as AsyncIterable<Buffer | string>) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const evt = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = this.parseSseEvent(evt);
        if (!parsed || parsed.event === 'done') continue;
        if (parsed.event === 'error') throw new Error(parsed.data);
        if (parsed.event === 'sources') {
          sources = JSON.parse(parsed.data) as ReturnType<AgentOrchestrator['toSources']>;
          if (sources.length > 0) emit({ type: 'sources', sources });
          continue;
        }
        if (parsed.event === 'metrics') {
          metrics = JSON.parse(parsed.data) as RagMetrics;
          emit({ type: 'metrics', metrics });
          continue;
        }
        const token = this.extractAssistantText(parsed);
        if (token.length > 0) {
          answer += token;
          emit({ type: 'token', token });
        }
      }
    }
    return { answer, sources, metrics };
  }

  private async finish(input: {
    runId: string;
    sessionId: string;
    question: string;
    answer: string;
    intent: string;
    citations: Citation[];
    verification: VerificationResult;
    fallbackUsed: boolean;
    insufficientEvidence: boolean;
    metrics: RagMetrics | null;
    startedAt: number;
    sources?: unknown;
    updateMemory?: boolean;
  }): Promise<AgentResponse> {
    if (input.answer.trim().length > 0) {
      await this.chat.appendMessage(
        input.sessionId,
        'assistant',
        input.answer,
        input.sources,
        input.metrics ?? undefined,
        {
          agentRunId: input.runId,
          intent: input.intent,
          verification: input.verification,
          fallbackUsed: input.fallbackUsed,
        },
      );
      await this.chat.touchSession(input.sessionId);
      if (input.updateMemory !== false) {
        await this.memory?.updateSessionMemory(input.sessionId, input.answer);
      }
    }
    await this.tracing.finishRun({
      runId: input.runId,
      intent: input.intent,
      fallbackUsed: input.fallbackUsed,
      insufficientEvidence: input.insufficientEvidence,
      totalLatencyMs: Date.now() - input.startedAt,
    });
    return {
      answer: input.answer,
      citations: input.citations,
      intent: input.intent as AgentResponse['intent'],
      verification: input.verification,
      fallbackUsed: input.fallbackUsed,
      insufficientEvidence: input.insufficientEvidence,
      agentRunId: input.runId,
      trace: {
        id: input.runId,
        question: input.question,
        intent: input.intent,
        steps: [],
        totalTokensIn: 0,
        totalTokensOut: 0,
        fallbackUsed: input.fallbackUsed,
        totalLatencyMs: Date.now() - input.startedAt,
      },
    };
  }

  private assertBudget(startedAt: number, budget: AgentRequest['budget']) {
    if (Date.now() - startedAt > budget.maxWallClockMs) {
      throw new BudgetExceededError('Agent wall clock budget exceeded');
    }
  }

  private assertLlmBudget(llmCalls: number, budget: AgentRequest['budget']) {
    if (llmCalls >= budget.maxLlmCalls) {
      throw new BudgetExceededError('Agent LLM budget exceeded');
    }
  }

  private queryKey(queries: string[]) {
    return queries
      .map((query) => query.trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join('\n');
  }

  private toSources(chunks: RetrievedChunk[]) {
    return chunks.map((chunk) => ({
      source: chunk.source,
      index: chunk.index,
      distance: chunk.distance,
      relevance: chunk.score,
    }));
  }

  private withMemory(question: string, memoryContext?: string) {
    if (!memoryContext) return question;
    return `${memoryContext}\n\nQUESTION:\n${question}`;
  }

  private dedupeChunks(chunks: RetrievedChunk[]): RetrievedChunk[] {
    const merged = new Map<string, RetrievedChunk>();
    for (const chunk of chunks) {
      const previous = merged.get(chunk.chunkId);
      if (!previous || chunk.score > previous.score) merged.set(chunk.chunkId, chunk);
    }
    return [...merged.values()].sort((a, b) => b.score - a.score);
  }

  private toCitations(chunks: RetrievedChunk[]): Citation[] {
    return chunks.map((chunk) => ({
      source: chunk.source,
      index: chunk.index,
      chunkId: chunk.chunkId,
    }));
  }
}
