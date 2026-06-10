---
title: RAG to Agentic RAG Migration Roadmap
status: TARGET_SPEC (Plano de Evolução / Arquitetura Futura)
depends_on:
  - 01_core_architecture.md
  - 02_rag_engine_spec.md
  - 03_crm_features_spec.md
description: Linha de tempo incremental dividida em 8 fases e cronograma de 6 semanas para a migração para Agentic RAG. Define os limites estritos do MVP (In-Scope vs Out-of-Scope) e serve como validador de progresso do projeto.
---

# Intelli-Dental — Migration Plan: RAG → Agentic RAG

> **Status:** Proposal / Architecture RFC
> **Scope:** Evolve the existing per-patient RAG assistant into an incremental, production-grade **Agentic RAG** without a rewrite.
> **Audience:** Backend (NestJS), RAG pipeline (Node/Fastify), Frontend (Next.js) engineers.
> **Constraints:** Fully local (Ollama + ChromaDB), multi-tenant by clinic, strict per-patient isolation, cost/latency/security sensitive.

This document is grounded in the **actual** Intelli-Dental codebase:

- `api/` — NestJS 11 trust boundary. Chat proxy in [`api/src/chat/chat.service.ts`](../api/src/chat/chat.service.ts), RAG client in [`api/src/rag/rag.service.ts`](../api/src/rag/rag.service.ts), schema in [`api/src/db/schema.ts`](../api/src/db/schema.ts).
- `rag-pipeline/` — Fastify service. HTTP surface in [`rag-pipeline/src/server.ts`](../rag-pipeline/src/server.ts), retrieval in [`rag-pipeline/src/retrieve/retriever.ts`](../rag-pipeline/src/retrieve/retriever.ts), generation/prompt in [`rag-pipeline/src/generate/prompt.ts`](../rag-pipeline/src/generate/prompt.ts) and [`rag-pipeline/src/generate/ollamaChat.ts`](../rag-pipeline/src/generate/ollamaChat.ts), metrics in `rag-pipeline/src/metrics/`.
- `app/` — Next.js 15 SSE consumer (`/assistant`).

A key existing asset: the chat already supports **slash-command actions** (`/listar`, `/criar`, `/remarcar`, …) via `POST /chat/sessions/:id/actions` with a `preview → commit` flow. **That is a proto-agent.** The migration formalizes it into a real orchestrator with tools, planning, and verification.

---

# 1. Incremental migration strategy

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

**Objective:** Decide, _before generating_, whether retrieved chunks can answer the question.

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
- **Success criteria:** "insufficient evidence" answers are _correct refusals_ (not laziness); measurable drop in hallucinated answers; p95 latency stays within SLA (e.g. <12s on CPU).
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
- **Ollama usage:** verification call, `temperature 0`, JSON. Tiered: cheap cosine groundedness first; LLM NLI check only if borderline. Fallback: if verifier fails, default to citation+threshold check; never _pass_ an uncited factual answer.
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

# 2. Implementation roadmap

Six weeks, one capability per week, each shippable behind a flag. Weeks map to the phases in §4 (Phase 1 spans week 1; Phases 2–3 share week 2; etc.).

## Week 1 — Foundations & baseline (Phase 1)

- **Deliverables:** `ModelGateway` + `OllamaService`; `tracing` module; `agent_runs`/`agent_steps`/`tool_calls` tables; golden set v1; baseline report.
- **Files/modules:** `models/`, `agent/tracing/`, `agent/contracts/index.ts`, `db/schema.agent.ts`, `api/test/golden/`.
- **Acceptance:** legacy chat works unchanged but now writes a trace; baseline metrics published.
- **Risks:** token counting accuracy. **Mitigation:** assert against Ollama `done` payload in a fixture.
- **Tests:** gateway JSON-mode/retry unit; trace persistence integration.

## Week 2 — Retrieval primitives + rewrite + evaluate (Phases 2–3)

- **Deliverables:** RAG `/v1/retrieve`,`/v1/generate`,`/v1/evaluate`; `RetrieverTool`; `QueryRewriterService`; `ContextEvaluatorService`.
- **Files/modules:** `rag/retriever.service.ts`, `agent/tools/retriever.tool.ts`, `agent/planner/query-rewriter.service.ts`, `agent/evaluators/context-evaluator.service.ts`, RAG `src/retrieve/*`, `src/metrics/*`.
- **Acceptance:** multi-query retrieval merges+dedups; evaluator returns sufficiency on golden set; recall ≥ +10%.
- **Risks:** query drift, latency. **Mitigation:** temp 0, N≤3, parallel retrieve.
- **Tests:** rewrite fallback; dedup; evaluator thresholds.

## Week 3 — CRAG loop + orchestrator skeleton (Phase 4)

- **Deliverables:** `AgentOrchestrator` (single-step path) with bounded retry + budget; `/chat/sessions/:id/agent` SSE endpoint (behind flag); insufficient-evidence fallback.
- **Files/modules:** `agent/orchestrator/*`, `agent/agent.controller.ts`, `agent/agent.service.ts`.
- **Acceptance:** weak-context questions trigger one retry then refuse correctly; no hallucination increase; p95 within SLA.
- **Risks:** loop cost. **Mitigation:** hard caps + budget guard + idempotent-query stop.
- **Tests:** loop cap, budget trip, fallback emission, SSE sequence.

## Week 4 — Intent Router + multi-step planner (Phase 5)

- **Deliverables:** `IntentRouterService` (+heuristic fallback); `QueryPlannerService`; orchestrator routes by intent; non-RAG paths (`direct_answer`, stubbed `database_query`).
- **Files/modules:** `agent/router/*`, `agent/planner/query-planner.service.ts`.
- **Acceptance:** routing accuracy ≥90% on golden set; fewer needless embed+generate calls.
- **Risks:** misrouting to direct_answer. **Mitigation:** bias to retrieval on low confidence; verifier still runs.
- **Tests:** per-archetype classification; uncertain⇒KB invariant; planner ≤4 steps.

## Week 5 — Tools + verifier (Phases 6–7)

- **Deliverables:** `ToolRegistry`; `AppointmentTool` (wrap `chat-actions`), `PatientRecordTool`; `PermissionService`; `AnswerVerifier`; preview/confirm SSE wired into Next.js.
- **Files/modules:** `agent/tools/*`, `agent/guardrails/permission.service.ts`, `agent/verifiers/answer-verifier.service.ts`, frontend confirm component reuse.
- **Acceptance:** mutations require confirm; permission denial enforced; hallucination <3%, citation accuracy ≥95%.
- **Risks:** verifier false positives. **Mitigation:** tiered cosine→LLM, one regenerate cap.
- **Tests:** schema/permission/confirm; unsupported-claim detection; injection-in-args.

## Week 6 — Hardening & rollout (Phase 8)

- **Deliverables:** sanitizer/injection suite; rate limiting; idempotency; caches (embedding + retrieval w/ corpusVersion); timeouts/cancel; dashboards; load test; flip flags on for a pilot clinic.
- **Files/modules:** `agent/guardrails/sanitizer.service.ts`, caching layer, `RateLimitGuard`, observability dashboards.
- **Acceptance:** injection suite green; load test passes SLA; no PII in info logs; cache invalidates on re-ingest.
- **Risks:** Ollama saturation. **Mitigation:** concurrency limits, keep_alive, fallback tier.
- **Tests:** load/soak, injection, cache-invalidation, tenant isolation E2E.

---

# 3. Recommended MVP

The smallest Agentic RAG that delivers value over today's pipeline, while staying safe and cheap.

## In scope (MVP)

1. **ModelGateway** (single model `phi3:mini` + `nomic-embed-text`), JSON mode, timeout, one JSON retry.
2. **Simple IntentRouter** — only three routes: `knowledge_base_search`, `action_request` (existing slash commands), `direct_answer`; everything uncertain ⇒ `knowledge_base_search`. Heuristic fallback.
3. **QueryRewriter** — 1–3 queries, temp 0, fallback to original.
4. **RetrieverTool** — wraps new `/v1/retrieve`, enforces `patientId`, normalizes scores, dedups.
5. **ContextEvaluator** — cosine gate only (reuse existing context-relevance); LLM gate deferred.
6. **Limited retry** — `MAX_RETRIEVAL_ATTEMPTS=1` + budget guard; canonical insufficient-evidence refusal.
7. **AnswerGenerator** — existing grounding prompt + citations, streamed (reuse `/v1/generate`).
8. **Basic AnswerVerifier** — citation presence + cosine groundedness threshold (no LLM NLI yet).
9. **Structured logs** — `agent_runs` + `agent_steps` + token/latency.

## Out of scope (defer)

- Multi-step `QueryPlanner` (use single step).
- LLM-based context evaluation and LLM-based verification (cosine only at first).
- `ToolSelector` LLM (map intent→tool deterministically); only existing appointment actions exposed.
- `PatientRecordTool` / `DocumentSummaryTool` (add after MVP).
- Per-task model routing, reranker on-by-default, hybrid search.
- Redis cache, queues, multi-agent, persistent memory.

## Why this MVP

It introduces the **decision layer** (router + evaluator + verifier) and the **tool abstraction** with minimal LLM cost (mostly cosine gates + one generation), directly attacks hallucination (verifier + refusal), and reuses every existing asset (isolation, metrics, actions, SSE). Each deferred item is an isolated upgrade behind its own flag.