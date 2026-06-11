import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module';
import { agentEvaluations, agentRuns, agentSteps, chatSessions, promptVersions, retrievedChunks, toolCalls } from '../../db/schemas';
import type { AgentContext, AgentStepType, ContextEvaluation, RetrievedChunk, ToolCall, VerificationResult } from '../contracts';
import { getPrompt, listPrompts } from '../prompts/registry';

@Injectable()
export class AgentTracingService implements OnModuleInit {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onModuleInit() {
    for (const prompt of listPrompts()) {
      const existing = await this.db
        .select({ id: promptVersions.id })
        .from(promptVersions)
        .where(eq(promptVersions.hash, prompt.hash))
        .limit(1);
      if (existing.length > 0) continue;
      await this.db.insert(promptVersions).values({
        module: prompt.module,
        version: prompt.version,
        hash: prompt.hash,
        body: prompt.body,
      });
    }
  }

  async startRun(ctx: AgentContext, question: string) {
    const [run] = await this.db
      .insert(agentRuns)
      .values({
        sessionId: ctx.sessionId,
        clinicId: ctx.clinicId,
        patientId: ctx.patientId,
        userId: ctx.userId,
        question,
      })
      .returning();
    return run;
  }

  async recordStep(input: {
    runId: string;
    seq: number;
    type: AgentStepType;
    startedAt: number;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    input?: unknown;
    output?: unknown;
    error?: { code: string; message: string };
  }) {
    const promptVersion = this.promptVersionFor(input.type);
    const [step] = await this.db
      .insert(agentSteps)
      .values({
        runId: input.runId,
        seq: input.seq,
        type: input.type,
        model: input.model,
        promptVersion,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        durationMs: Date.now() - input.startedAt,
        input: input.input as never,
        output: input.output as never,
        error: input.error as never,
      })
      .returning();
    return step;
  }

  async recordRetrievedChunks(runId: string, stepId: string | undefined, chunks: RetrievedChunk[]) {
    if (chunks.length === 0) return;
    await this.db.insert(retrievedChunks).values(
      chunks.map((chunk) => ({
        runId,
        stepId,
        chunkId: chunk.chunkId,
        source: chunk.source,
        chunkIndex: chunk.index,
        distance: chunk.distance,
        score: chunk.score,
      })),
    );
  }

  async recordContextEvaluation(runId: string, evaluation: ContextEvaluation) {
    await this.db.insert(agentEvaluations).values({
      runId,
      kind: 'context',
      sufficient: evaluation.sufficient,
      score: evaluation.score,
      payload: evaluation as never,
    });
  }

  async recordVerification(runId: string, verification: VerificationResult) {
    await this.db.insert(agentEvaluations).values({
      runId,
      kind: 'verification',
      faithful: verification.faithful,
      groundedness: verification.groundedness,
      citationsOk: verification.citationsOk,
      payload: verification as never,
    });
  }

  async recordTool(runId: string, call: ToolCall, result: { ok: boolean; data?: unknown; error?: unknown; mutated: boolean }) {
    await this.db.insert(toolCalls).values({
      runId,
      name: call.name,
      args: call.args as never,
      mode: call.mode,
      ok: result.ok,
      mutated: result.mutated,
      result: result.data as never,
      error: result.error as never,
    });
  }

  async finishRun(input: {
    runId: string;
    intent?: string;
    fallbackUsed: boolean;
    insufficientEvidence: boolean;
    totalLatencyMs: number;
    error?: { code: string; message: string };
  }) {
    await this.db
      .update(agentRuns)
      .set({
        intent: input.intent,
        fallbackUsed: input.fallbackUsed,
        insufficientEvidence: input.insufficientEvidence,
        totalLatencyMs: input.totalLatencyMs,
        error: input.error as never,
      })
      .where(eq(agentRuns.id, input.runId));
  }

  async getTraceForUser(runId: string, clinicId: string, userId: string) {
    const [run] = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.clinicId, clinicId), eq(agentRuns.userId, userId)))
      .limit(1);
    if (!run) return null;
    const steps = await this.db
      .select()
      .from(agentSteps)
      .where(eq(agentSteps.runId, runId))
      .orderBy(agentSteps.seq);
    const chunks = await this.db
      .select({
        id: retrievedChunks.id,
        stepId: retrievedChunks.stepId,
        chunkId: retrievedChunks.chunkId,
        source: retrievedChunks.source,
        chunkIndex: retrievedChunks.chunkIndex,
        distance: retrievedChunks.distance,
        score: retrievedChunks.score,
      })
      .from(retrievedChunks)
      .where(eq(retrievedChunks.runId, runId));
    const evaluations = await this.db
      .select()
      .from(agentEvaluations)
      .where(eq(agentEvaluations.runId, runId));
    const tools = await this.db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.runId, runId));
    return { run, steps, chunks, evaluations, tools };
  }

  private promptVersionFor(type: AgentStepType): string | undefined {
    if (
      type === 'intent' ||
      type === 'rewrite' ||
      type === 'plan' ||
      type === 'evaluate' ||
      type === 'generate' ||
      type === 'verify'
    ) {
      return getPrompt(type).version;
    }
    if (type === 'tool') return getPrompt('tool_select').version;
    return undefined;
  }
}
