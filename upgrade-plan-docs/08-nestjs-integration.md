# 8. Nest.js integration

## 8.1 Folder structure

```
api/src/
  agent/
    agent.module.ts
    agent.controller.ts          # POST /chat/sessions/:id/agent (SSE), /confirm
    agent.service.ts             # thin facade → orchestrator
    contracts/
      index.ts                   # all interfaces from §6
    orchestrator/
      agent-orchestrator.ts
      budget.guard.ts            # AgentBudget enforcement (not a Nest guard)
    router/
      intent-router.service.ts
    planner/
      query-planner.service.ts
      query-rewriter.service.ts
    tools/
      tool-registry.service.ts
      retriever.tool.ts
      patient-record.tool.ts
      appointment.tool.ts        # wraps existing chat-actions.service.ts
      document-summary.tool.ts
    evaluators/
      context-evaluator.service.ts
    verifiers/
      answer-verifier.service.ts
    generators/
      answer-generator.service.ts
    prompts/
      intent.prompt.ts
      rewrite.prompt.ts
      plan.prompt.ts
      evaluate.prompt.ts
      generate.prompt.ts          # reuses existing SYSTEM_PROMPT rules
      verify.prompt.ts
      tool-select.prompt.ts
      registry.ts                 # versioned prompt lookup
    guardrails/
      sanitizer.service.ts        # prompt-injection scrubbing
      permission.service.ts
    tracing/
      tracing.service.ts          # writes agent_runs / agent_steps / tool_calls
      trace.interceptor.ts
    dto/
      agent-request.dto.ts
      confirm.dto.ts
  rag/
    rag.module.ts                 # existing
    retriever.service.ts          # NEW: typed client for /v1/retrieve, /v1/evaluate
    rag.service.ts                # existing proxy client (kept)
  models/
    models.module.ts
    ollama.service.ts             # low-level Ollama HTTP (chat/generate/embeddings)
    model-gateway.service.ts      # task→model routing, JSON, retries, fallback
```

## 8.2 Controller (SSE + confirmation)

```ts
@Controller('chat/sessions/:sessionId')
@UseGuards(JwtAuthGuard, ClinicScopeGuard, PatientScopeGuard)
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly chat: ChatService,
  ) {}

  @Post('agent')
  async ask(
    @Param('sessionId') sessionId: string,
    @Body() dto: AgentRequestDto,
    @CurrentUser() user: AuthUser,
    @ActiveClinic() clinicId: string,
    @Res() res: Response,
  ) {
    const session = await this.chat.getSession(clinicId, user.id, sessionId);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const emit = (ev: AgentStreamEvent) => {
      // map internal event → SSE frame, mirroring the current rag-pipeline shape
      if (ev.type === 'token') res.write(`data: ${JSON.stringify(ev.token)}\n\n`);
      else if (ev.type === 'sources') res.write(`event: sources\ndata: ${JSON.stringify(ev.sources)}\n\n`);
      else res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    const onAbort = () => this.agent.cancel(session.id);  // abort Ollama stream on disconnect
    res.on('close', onAbort);
    try {
      await this.agent.run({
        question: dto.question,
        context: this.agent.buildContext(session, user, clinicId),
        budget: this.agent.defaultBudget(),
        confirm: dto.confirm,
      }, emit);
    } catch (err) {
      emit({ type: 'error', code: 'agent_failed', message: 'Não foi possível completar a solicitação.' });
    } finally {
      res.end();
    }
  }
}
```

## 8.3 Module wiring (dependency injection)

```ts
@Module({
  imports: [ConfigModule, DbModule, RagModule, ModelsModule, ChatModule],
  controllers: [AgentController],
  providers: [
    AgentService,
    AgentOrchestrator,
    IntentRouterService,
    QueryRewriterService,
    QueryPlannerService,
    ContextEvaluatorService,
    AnswerGeneratorService,
    AnswerVerifierService,
    ToolRegistryService,
    RetrieverTool,
    PatientRecordTool,
    AppointmentTool,
    DocumentSummaryTool,
    SanitizerService,
    PermissionService,
    TracingService,
    { provide: 'AGENT_FLAGS', useFactory: (c: ConfigService) => ({
        router: c.get('AGENT_ROUTER_ENABLED') === 'true',
        crag:   c.get('AGENT_CRAG_ENABLED') === 'true',
        verify: c.get('AGENT_VERIFY_ENABLED') === 'true',
      }), inject: [ConfigService] },
  ],
})
export class AgentModule {}
```

## 8.4 Services / Providers / DTOs / Guards / Interceptors

- **Services:** each module in §5 is a provider; `AgentService` is a thin facade so the controller never touches the orchestrator internals.
- **Providers:** tools are providers registered into `ToolRegistryService` via `OnModuleInit` (each tool calls `registry.register(this.definition)`).
- **DTOs:** `AgentRequestDto { question: string; confirm?: { toolCallId: string } }` validated with `class-validator` (`@IsString() @MaxLength(2000)`).
- **Guards:** reuse `JwtAuthGuard`; add `PatientScopeGuard` that asserts the session's patient ∈ the active clinic (mirrors `ChatService.getSession`). A `RateLimitGuard` (per user+clinic) on the `agent` route.
- **Interceptors:** `TraceInterceptor` opens/closes the `agent_run` and attaches `agentRunId` to the request; a `TimeoutInterceptor` enforces `maxWallClockMs`.
- **Logs:** structured (`Logger` with JSON transport). Never log raw chunk text at `info`; gate it behind `LOG_LEVEL=debug`.

## 8.5 Unit tests

```ts
describe('IntentRouterService', () => {
  it('routes slash-prefixed message to action_request via heuristic when LLM fails', async () => {
    gateway.complete.mockRejectedValueOnce(new ModelUnavailableError());
    const r = await router.classify('/listar', ctx);
    expect(r.intent).toBe('action_request');
  });
  it('defaults to knowledge_base_search on low confidence', async () => {
    gateway.complete.mockResolvedValueOnce({ parsedJson: { intent: 'direct_answer', confidence: 0.2 } } as any);
    const r = await router.classify('hmm', ctx);
    expect(r.intent).toBe('knowledge_base_search');
  });
});
```

## 8.6 Integration tests

- Boot the Nest app with `ModelGateway` and `RetrieverService` mocked (fake Ollama + fake ChromaDB) using `Test.createTestingModule`.
- Drive `POST /chat/sessions/:id/agent`, assert the SSE frame sequence (`step:intent → … → done`) and that an `agent_run` + steps were persisted.
- Tenant isolation test: a session for clinic A cannot be queried by a user of clinic B (expect 403 from `PatientScopeGuard`).

---
