import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { ModelsModule } from '../models/models.module';
import { RagModule } from '../rag/rag.module';
import { AgentController, AgentRunsController } from './agent.controller';
import { AgentFeatureFlagsService } from './config/agent-feature-flags.service';
import { AgentService } from './agent.service';
import { ContextEvaluatorService } from './evaluators/context-evaluator.service';
import { AnswerGeneratorService } from './generators/answer-generator.service';
import { SanitizerService } from './guardrails/sanitizer.service';
import { PermissionService } from './guardrails/permission.service';
import { AgentRateLimitGuard } from './guardrails/rate-limit.guard';
import { AgentMetricsService } from './metrics/agent-metrics.service';
import { MemoryService } from './memory/memory.service';
import { AgentOrchestrator } from './orchestrator/agent-orchestrator';
import { QueryPlannerService } from './planner/query-planner.service';
import { QueryRewriterService } from './planner/query-rewriter.service';
import { HeuristicRouter } from './router/heuristic-router';
import { IntentRouterService } from './router/intent-router.service';
import { AgentTracingService } from './tracing/agent-tracing.service';
import { RetrieverTool } from './tools/retriever.tool';
import { ToolRegistryService } from './tools/tool-registry.service';
import { AnswerVerifierService } from './verifiers/answer-verifier.service';

@Module({
  imports: [ChatModule, RagModule, ModelsModule],
  controllers: [AgentController, AgentRunsController],
  providers: [
    AgentService,
    AgentFeatureFlagsService,
    AgentOrchestrator,
    HeuristicRouter,
    IntentRouterService,
    QueryPlannerService,
    QueryRewriterService,
    AnswerGeneratorService,
    RetrieverTool,
    ToolRegistryService,
    ContextEvaluatorService,
    AnswerVerifierService,
    SanitizerService,
    PermissionService,
    AgentRateLimitGuard,
    AgentMetricsService,
    MemoryService,
    AgentTracingService,
  ],
})
export class AgentModule {}
