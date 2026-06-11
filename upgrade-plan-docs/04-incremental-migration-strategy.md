# 4. Incremental migration strategy

Guiding rule: **every phase ships behind a flag, is independently testable, and degrades to current behavior on failure.** Use one feature flag per capability (e.g. `AGENT_ROUTER_ENABLED`, `AGENT_CRAG_ENABLED`) read by the orchestrator.

> Cross-cutting for all phases: changes are additive. The legacy `/v1/chat` keeps working; the orchestrator wraps it. Each new LLM-backed module **must** declare input shape, output JSON schema, temperature, and a deterministic fallback.

## Phase 1 — Instrumentation & baseline

**Objective:** Make the current RAG measurable before changing it. You cannot prove "better" without a baseline.

- **Components:** RAG Pipeline, NestJS, Postgres.
- **NestJS changes:** add `tracing/` module; create `agent_runs`, `agent_steps`, `tool_calls` tables (used trivially at first — one run, one `legacy_rag` step). Add a `TraceInterceptor` that wraps chat requests and records latency, model, token counts.
- **RAG Pipeline changes:** return structured timing + token usage from `/v1/chat` (capture Ollama `done` payload counts). Expose `/v1/evaluate` as a standalone endpoint reusing `evaluateTriad`.
- **Next.js changes:** none required; optionally add a hidden "debug trace" panel.
- **Ollama usage:** none new.
- **Dataset:** assemble a **golden set** of 30–50 real clinical questions per archetype (factual lookup, summarization, multi-fact, out-of-scope, injection attempt) with expected answers/citations. Store as fixtures under `api/test/golden/`.
- **Risks:** under-counting tokens; PII in logs. Mitigate by hashing/omitting document text in traces (store chunk ids + scores, not raw content, at low log levels).
- **Success criteria:** for the golden set you can report baseline context-relevance, groundedness, answer-relevance, latency p50/p95, and a manual hallucination rate.
- **Tests:** snapshot test that a chat run writes exactly one `agent_run` + steps; metrics persisted.

## Phase 2 — Query Rewriting

**Objective:** Improve recall by reformulating/expanding the user question before retrieval.

- **Components:** new `QueryRewriter` (NestJS), RAG `/v1/retrieve`.
- **NestJS changes:** `QueryRewriterService` (LLM, JSON output `{ queries: string[] }`). Entity normalization for clinical terms (e.g. "açúcar no sangue" → "glicemia/diabetes") via a small synonym map + LLM expansion. Multi-query: call retrieve per query, merge + dedup by chunk id, keep best score.
- **RAG Pipeline changes:** split `/v1/chat` → expose `/v1/retrieve` (returns chunks+scores, no generation). Add chunk dedup + score normalization (cosine→[0,1]).
- **Next.js changes:** show "searched for: …" chips (the rewritten queries) in the debug panel.
- **Ollama usage:** **new** call — small/fast model (phi3:mini or `llama3.2:3b`), `temperature 0`, JSON mode, capped `num_predict`. Fallback: on invalid JSON or timeout, use the original question verbatim (no-op rewrite).
- **Risks:** query drift (rewrites change meaning) → mitigate with low temperature + later verifier; latency from N queries → cap N≤3, retrieve in parallel.
- **Success criteria:** context-recall on golden set improves ≥10% vs baseline with ≤1 extra LLM call and ≤+300ms p50.
- **Tests:** unit (rewriter returns ≤3 queries, valid JSON, fallback path), retrieval test (merged set ⊇ baseline set).

## Phase 3 — Context Evaluator

**Objective:** Decide, *before generating*, whether retrieved chunks can answer the question.

- **Components:** new `ContextEvaluator` (NestJS), reuse RAG `/v1/evaluate` for cheap signal.
- **NestJS changes:** `ContextEvaluatorService` returns `{ sufficient, score, missing[], suggestedQuery? }`. Two-tier: (a) **cheap gate** — existing context-relevance (cosine) threshold; (b) **LLM gate** only if the cheap gate is borderline, to save tokens.
- **RAG Pipeline changes:** ensure `/v1/evaluate` can score `(question, chunks)` without a generated answer (context-relevance only).
- **Next.js changes:** debug panel shows `sufficient: true/false` + missing aspects.
- **Ollama usage:** conditional LLM call, `temperature 0`, JSON output. Fallback: if LLM fails, use the cosine threshold decision.
- **Risks:** evaluator too strict (always retries) or too lax. Tune thresholds on the golden set; expose as config.
- **Success criteria:** evaluator agrees with human "is this enough?" label ≥80% on golden set; no increase in wrong answers.
- **Tests:** unit with synthetic chunk sets (clearly-sufficient, clearly-insufficient, borderline); threshold regression test.

## Phase 4 — Iterative Retrieval (CRAG loop)

**Objective:** When context is weak, retry retrieval with the evaluator's `suggestedQuery`, bounded and cost-capped.

- **Components:** `AgentOrchestrator` loop, `QueryRewriter`, `ContextEvaluator`, `RetrieverTool`.
- **NestJS changes:** implement the bounded loop: `MAX_RETRIEVAL_ATTEMPTS` (default 2), a per-run **budget** (max LLM calls, max wall-clock ms). On exhaustion → deterministic fallback "Não encontrei evidências suficientes nos registros do paciente."
- **RAG Pipeline changes:** none beyond Phase 2/3 endpoints.
- **Next.js changes:** stream `step: retrieve` per attempt so the user sees progress.
- **Ollama usage:** rewriter re-invoked per attempt; cap total calls per run.
- **Risks:** infinite/expensive loops. Mitigate with hard attempt cap + budget guard + idempotent retrieval (same query ⇒ stop).
- **Success criteria:** "insufficient evidence" answers are *correct refusals* (not laziness); measurable drop in hallucinated answers; p95 latency stays within SLA (e.g. <12s on CPU).
- **Tests:** loop terminates within cap; budget guard trips; fallback emitted when evidence absent.

## Phase 5 — Intent Router

**Objective:** Route each question to the cheapest correct strategy; avoid RAG when unnecessary.

- **Components:** new `IntentRouter` (NestJS).
- **NestJS changes:** `IntentRouterService` → `{ intent, confidence, needsRetrieval, needsTool }`. Wire routes: `direct_answer`, `knowledge_base_search`, `database_query`, `document_summary`, `multi_step_question`, `action_request`, `unsupported`. Low-confidence → default to `knowledge_base_search` (safest grounded path).
- **RAG Pipeline changes:** none.
- **Next.js changes:** show detected intent chip.
- **Ollama usage:** **new** classification call — small model, `temperature 0`, strict JSON, tiny output. Fallback: keyword heuristics (starts with `/` → action; contains "telefone/CPF/idade" → database_query) when LLM fails.
- **Risks:** misrouting (e.g. clinical question routed to direct_answer → hallucination). Mitigate: bias toward retrieval on uncertainty; verifier still runs.
- **Success criteria:** routing accuracy ≥90% on golden set; reduction in unnecessary embed+generate calls for non-RAG questions.
- **Tests:** classification unit tests per archetype; heuristic-fallback tests; "uncertain ⇒ knowledge_base_search" invariant.

## Phase 6 — Tool Calling

**Objective:** Expose internal capabilities as typed, permissioned tools the orchestrator can call; formalize the existing actions.

- **Components:** `ToolRegistry`, `RetrieverTool`, `PatientRecordTool`, `AppointmentTool`, `DocumentSummaryTool`.
- **NestJS changes:** define `ToolDefinition` with zod input/output schemas + required permission + `mutating` flag. Wrap existing `chat-actions.service.ts` as `AppointmentTool` (reusing its `preview → commit`). `PatientRecordTool` = parameterized, tenant-scoped Drizzle reads (never raw SQL from the LLM). Parameter validation via zod before execution.
- **RAG Pipeline changes:** none (RetrieverTool calls `/v1/retrieve`).
- **Next.js changes:** render `preview` events for mutating tools with Confirm/Cancel (reuse existing component).
- **Ollama usage:** a `ToolSelector` prompt may pick a tool + arguments (JSON). Fallback: deterministic mapping from intent → tool when selection is ambiguous.
- **Risks:** tool abuse, dangerous actions, argument injection. Mitigate: **no mutating tool auto-executes** — always preview+confirm; permission check per call; arg schema validation; allow-list of tools per intent.
- **Success criteria:** all mutations pass through confirmation; zero unauthorized tool executions in tests; tool arg validation rejects malformed input.
- **Tests:** schema validation, permission denial, mutating-tool-requires-confirm, injection-in-args rejected.

## Phase 7 — Answer Verifier

**Objective:** Before returning, verify the answer is faithful to the retrieved context and properly cited.

- **Components:** new `AnswerVerifier` (NestJS), reuse groundedness from `/v1/evaluate`.
- **NestJS changes:** `AnswerVerifierService` → `{ faithful, unsupportedClaims[], citationsOk, action: "pass"|"regenerate"|"downgrade" }`. On `regenerate` (once): re-call generator with a stricter prompt. On `downgrade`: strip unsupported sentences or return a safe refusal.
- **RAG Pipeline changes:** ensure `/v1/evaluate` returns per-sentence groundedness (conceptually already in RAG-Triad).
- **Next.js changes:** badge answers as "verified" / show which claims were dropped (debug).
- **Ollama usage:** verification call, `temperature 0`, JSON. Tiered: cheap cosine groundedness first; LLM NLI check only if borderline. Fallback: if verifier fails, default to citation+threshold check; never *pass* an uncited factual answer.
- **Risks:** verifier false-positives (drops correct claims) hurt UX; verifier cost. Mitigate with tiering + thresholds + one regenerate cap.
- **Success criteria:** hallucination rate on golden set drops to target (e.g. <3%); citation accuracy ≥95%; added latency ≤+1.5s p50.
- **Tests:** unsupported-claim detection, citation enforcement, regenerate-once cap, "fabricated fact" caught.

## Phase 8 — Production hardening

**Objective:** Make it safe, fast, and operable under load.

- **Components:** all.
- **NestJS changes:** rate limiting (per user/clinic), idempotency keys for mutations, request/agent timeouts + cancellation (abort Ollama stream on client disconnect), caching (embedding cache; retrieval cache by `(patientId, normalizedQuery, corpusVersion)`), structured logs + trace persistence, full prompt-injection defense, dashboards.
- **RAG Pipeline changes:** embedding cache; concurrency limits to protect Ollama; backpressure on `/v1/ingest`.
- **Next.js changes:** graceful cancel button (aborts SSE), error toasts mapped to error codes.
- **Ollama usage:** model routing finalized (per-task models), warm-up calls, fallback model tier; per-task `keep_alive`.
- **Risks:** Ollama saturation on CPU; cache staleness after re-ingest. Mitigate with cache keys including a per-patient `corpusVersion` bumped on ingest.
- **Success criteria:** sustained load test passes SLA; injection test-suite green; no PII leakage in logs; graceful degradation under Ollama timeout.
- **Tests:** load/soak, injection suite, cache-invalidation-on-reingest, timeout/cancel, permission/tenant isolation E2E.

---
