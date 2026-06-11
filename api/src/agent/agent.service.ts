import { Injectable } from '@nestjs/common';
import { ChatService } from '../chat/chat.service';
import { AgentFeatureFlagsService } from './config/agent-feature-flags.service';
import type { AgentContext, AgentRequest, AgentStreamEvent } from './contracts';
import { AgentMetricsService } from './metrics/agent-metrics.service';
import { AgentOrchestrator } from './orchestrator/agent-orchestrator';
import { AgentTracingService } from './tracing/agent-tracing.service';

@Injectable()
export class AgentService {
  constructor(
    private readonly chat: ChatService,
    private readonly orchestrator: AgentOrchestrator,
    private readonly flags: AgentFeatureFlagsService,
    private readonly tracing: AgentTracingService,
    private readonly metrics: AgentMetricsService,
  ) {}

  getSession(clinicId: string, userId: string, sessionId: string) {
    return this.chat.getSession(clinicId, userId, sessionId);
  }

  defaultBudget(): AgentRequest['budget'] {
    return {
      maxLlmCalls: this.flags.int('AGENT_MAX_LLM_CALLS', 3),
      maxRetrievalAttempts: this.flags.int('AGENT_MAX_RETRIEVAL_ATTEMPTS', 1),
      maxWallClockMs: this.flags.int('AGENT_MAX_WALL_CLOCK_MS', 15000),
    };
  }

  run(
    req: Omit<AgentRequest, 'budget'> & { budget?: AgentRequest['budget'] },
    emit: (ev: AgentStreamEvent) => void,
  ) {
    return this.orchestrator.run(
      { ...req, budget: req.budget ?? this.defaultBudget() },
      emit,
    );
  }

  parseSseEvent(raw: string) {
    return this.orchestrator.parseSseEvent(raw);
  }

  extractAssistantText(parsed: NonNullable<ReturnType<AgentOrchestrator['parseSseEvent']>>) {
    return this.orchestrator.extractAssistantText(parsed);
  }

  appendAssistantMessage(
    sessionId: string,
    text: string,
    sources?: unknown,
    metrics?: {
      contextRelevance?: number | null;
      groundedness?: number | null;
      answerRelevance?: number | null;
      perChunk?: number[] | null;
    },
  ) {
    return this.chat.appendMessage(sessionId, 'assistant', text, sources, metrics);
  }

  touchSession(sessionId: string) {
    return this.chat.touchSession(sessionId);
  }

  getTrace(runId: string, clinicId: string, userId: string) {
    return this.tracing.getTraceForUser(runId, clinicId, userId);
  }

  getMetrics(clinicId: string) {
    return this.metrics.report(clinicId);
  }
}
