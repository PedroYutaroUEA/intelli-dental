# 5. Design of the main modules

All modules are NestJS providers (`@Injectable()`), unit-testable in isolation, and depend on `ModelGateway` for any LLM call. Every LLM-backed module returns a **typed, validated** result (zod-parsed) and has a **deterministic fallback**.

## 5.1 AgentOrchestrator

**Responsibility:** Own the end-to-end loop as a deterministic state machine. Decide route, call tools, retry retrieval within budget, stop, and emit the final answer or a safe error. It is the only component that writes `agent_runs`/`agent_steps`.

```ts
export interface IAgentOrchestrator {
  run(req: AgentRequest, emit: (ev: AgentStreamEvent) => void): Promise<AgentResponse>;
}
```

- **Input:** `AgentRequest` (question, patientId, clinicId, userId, sessionId, permissions, budget).
- **Output:** `AgentResponse` (answer, citations, intent, trace, verification, fallbackUsed).
- **Errors:** `BudgetExceededError`, `GuardrailViolationError`, `ToolExecutionError`, `ModelUnavailableError` → all mapped to a safe user message + `event: error`.
- **State machine (pseudocode):**

```ts
async run(req, emit) {
  const trace = this.tracing.start(req);            // agent_run_id
  const q = this.guard.sanitize(req.question);      // strip injection
  emit({ type: 'step', step: 'intent' });
  const intent = await this.router.classify(q, req);
  trace.record('intent', intent);

  if (intent.intent === 'unsupported') return this.refuse(req, trace, emit);
  if (intent.intent === 'direct_answer') return this.answerDirect(q, req, trace, emit);
  if (intent.intent === 'action_request') return this.handleAction(q, req, trace, emit);
  if (intent.intent === 'database_query') return this.handleDbQuery(q, req, trace, emit);

  // RAG / multi-step path
  const plan = intent.intent === 'multi_step_question'
    ? await this.planner.plan(q, req)
    : QueryPlanner.singleStep(q);
  trace.record('plan', plan);

  const evidence: RetrievedChunk[] = [];
  for (const step of plan.steps) {
    let attempt = 0, ok = false;
    let queries = await this.rewriter.rewrite(step.question, req);
    while (attempt < req.budget.maxRetrievalAttempts && !ok) {
      this.budget.assert(trace);                    // throws BudgetExceededError
      emit({ type: 'step', step: 'retrieve', data: { attempt, queries } });
      const chunks = await this.retriever.retrieveMany(queries, req);
      const evalRes = await this.contextEvaluator.evaluate(step.question, chunks, req);
      trace.record('evaluate', evalRes);
      if (evalRes.sufficient) { evidence.push(...chunks); ok = true; break; }
      if (evalRes.suggestedQuery) queries = [evalRes.suggestedQuery];
      attempt++;
    }
    if (!ok && plan.steps.length === 1) return this.insufficient(req, trace, emit);
  }

  const draft = await this.generator.generate(q, dedupe(evidence), req, emit); // streams tokens
  const verdict = await this.verifier.verify(q, draft, evidence, req);
  trace.record('verify', verdict);
  const final = this.applyVerdict(draft, verdict, evidence, req, emit);
  await this.persist(req, final, evidence, trace);
  emit({ type: 'done', agentRunId: trace.id });
  return final;
}
```

- **Usage example:** called by `AgentController` on `POST /chat/sessions/:id/agent`, passing an `emit` that writes SSE frames.

## 5.2 IntentRouter

**Responsibility:** Classify the question into one route. Cheap, fast, JSON-only. Biases to `knowledge_base_search` on low confidence.

```ts
export type Intent =
  | 'direct_answer' | 'knowledge_base_search' | 'database_query'
  | 'document_summary' | 'multi_step_question' | 'action_request' | 'unsupported';

export interface IntentResult {
  intent: Intent;
  confidence: number;        // 0..1
  needsRetrieval: boolean;
  needsTool: boolean;
  reason: string;
}

export interface IIntentRouter {
  classify(question: string, ctx: AgentContext): Promise<IntentResult>;
}
```

- **Input:** sanitized question + lightweight context (does the patient have documents? is the message a slash command?).
- **Output:** `IntentResult`.
- **Errors:** `ModelUnavailableError` → fallback to heuristics (`/` prefix ⇒ `action_request`; PII keywords ⇒ `database_query`; else `knowledge_base_search`).
- **Usage:** `const intent = await router.classify(q, ctx)`.

## 5.3 QueryRewriter

**Responsibility:** Turn one question into 1–3 normalized, expanded retrieval queries (synonyms, clinical entity normalization), preserving meaning.

```ts
export interface RewriteResult { queries: string[]; normalizedEntities?: Record<string,string>; }

export interface IQueryRewriter {
  rewrite(question: string, ctx: AgentContext): Promise<RewriteResult>;
}
```

- **Input:** question + optional `suggestedQuery` from the evaluator.
- **Output:** `RewriteResult` (`queries.length` 1..3, deduped).
- **Errors:** invalid JSON / timeout → fallback `{ queries: [question] }`.
- **Usage:** `const { queries } = await rewriter.rewrite(q, ctx)`.

## 5.4 QueryPlanner

**Responsibility:** Decompose a complex/multi-part question into ordered sub-questions, each independently retrievable.

```ts
export interface IQueryPlanner {
  plan(question: string, ctx: AgentContext): Promise<QueryPlan>;
  // static helper for trivial case
}
export interface QueryPlan { steps: PlannedStep[]; strategy: 'single' | 'sequential'; }
```

- **Input:** question flagged `multi_step_question`.
- **Output:** `QueryPlan` (≤4 steps to bound cost).
- **Errors:** invalid JSON → fallback single step `{ steps: [{ question }], strategy: 'single' }`.
- **Usage:** `const plan = await planner.plan(q, ctx)`.

## 5.5 RetrieverTool

**Responsibility:** Wrap the RAG pipeline `/v1/retrieve` as a typed tool. Enforce `patientId` filter (never optional), merge multi-query results, dedup, normalize scores.

```ts
export interface IRetrieverTool {
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
  retrieveMany(queries: string[], ctx: AgentContext): Promise<RetrievedChunk[]>;
}
```

- **Input:** `RetrievalQuery` (text, patientId, k, filters, rerank).
- **Output:** `RetrievalResult` (chunks with normalized scores + sources).
- **Errors:** `ServiceUnavailableException` (RAG down) → orchestrator decides fallback; never returns cross-patient data.
- **Usage:** `const chunks = await retriever.retrieveMany(['glicemia','diabetes'], ctx)`.

## 5.6 ContextEvaluator

**Responsibility:** Judge if chunks can answer the question. Two-tier (cosine gate → optional LLM gate). Suggest a better query when insufficient.

```ts
export interface IContextEvaluator {
  evaluate(question: string, chunks: RetrievedChunk[], ctx: AgentContext): Promise<ContextEvaluation>;
}
```

- **Input:** question + candidate chunks.
- **Output:** `ContextEvaluation` (`sufficient`, `score`, `missing[]`, `suggestedQuery?`).
- **Errors:** LLM failure → decide by cosine threshold only.
- **Usage:** `const ev = await evaluator.evaluate(q, chunks, ctx)`.

## 5.7 AnswerGenerator

**Responsibility:** Produce the final grounded answer from evidence, streamed token-by-token, with inline citations. Reuses the existing system prompt rules.

```ts
export interface IAnswerGenerator {
  generate(
    question: string, evidence: RetrievedChunk[], ctx: AgentContext,
    emit?: (token: string) => void,
  ): Promise<GeneratedAnswer>;
}
export interface GeneratedAnswer { text: string; citations: Citation[]; tokensIn?: number; tokensOut?: number; }
```

- **Input:** question + deduped evidence (or empty for `direct_answer`, with a stricter no-context prompt).
- **Output:** `GeneratedAnswer` (text + extracted citations).
- **Errors:** Ollama failure → `ModelUnavailableError` (safe message). Empty evidence in RAG mode ⇒ returns the canonical "insufficient evidence" string.
- **Usage:** `const ans = await generator.generate(q, ev, ctx, t => emit({type:'token', token:t}))`.

## 5.8 AnswerVerifier

**Responsibility:** Check faithfulness: every factual sentence supported by evidence, citations present and valid. Decide pass / regenerate / downgrade.

```ts
export interface IAnswerVerifier {
  verify(question: string, answer: GeneratedAnswer, evidence: RetrievedChunk[], ctx: AgentContext): Promise<VerificationResult>;
}
```

- **Input:** question, draft answer, evidence.
- **Output:** `VerificationResult` (`faithful`, `unsupportedClaims[]`, `citationsOk`, `action`, `groundedness`).
- **Errors:** verifier LLM failure → fallback to cosine groundedness + citation presence check.
- **Usage:** `const v = await verifier.verify(q, ans, ev, ctx)`.

## 5.9 ToolRegistry

**Responsibility:** Hold all `ToolDefinition`s, expose lookup + permission checks + schema validation. Single source of truth for what the agent may call.

```ts
export interface IToolRegistry {
  get(name: string): ToolDefinition | undefined;
  list(ctx: AgentContext): ToolDefinition[];          // permission-filtered
  execute(call: ToolCall, ctx: AgentContext): Promise<ToolResult>;
}
```

- **Input:** `ToolCall` (name, args).
- **Output:** `ToolResult` (ok, data | error, mutated).
- **Errors:** `ToolNotFoundError`, `PermissionDeniedError`, `SchemaValidationError`, `ConfirmationRequiredError` (mutating tool without confirm).
- **Usage:** `const res = await registry.execute({ name:'appointment.create', args }, ctx)`.

## 5.10 ModelGateway

**Responsibility:** Single choke point for Ollama. Per-task model routing, temperature, JSON mode, timeouts, retries on invalid JSON, fallback model tier, token accounting. Enables future model replacement without touching modules.

```ts
export interface IModelGateway {
  complete(req: ModelRequest): Promise<ModelResponse>;            // non-streaming, JSON-capable
  stream(req: ModelRequest, onToken: (t: string) => void): Promise<ModelResponse>;
  embed(texts: string[]): Promise<number[][]>;
}
```

- **Input:** `ModelRequest` (task, messages, json?, temperature?, maxTokens?, timeoutMs?).
- **Output:** `ModelResponse` (text, parsedJson?, model, tokensIn, tokensOut, latencyMs).
- **Errors:** `ModelTimeoutError`, `InvalidJsonError` (after retries), `ModelUnavailableError`.
- **Usage:** `const r = await gateway.complete({ task:'intent', messages, json:true, temperature:0 })`.

---
