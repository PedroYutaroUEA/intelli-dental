# 20. Final deliverable

## 20.1 Executive summary
Dental-CRM already runs a working, isolated, per-patient RAG (NestJS trust boundary → Fastify RAG → Ollama/ChromaDB) with RAG-Triad metrics and a slash-command action system using `preview → commit`. This plan evolves it **incrementally** into a **deterministic Agentic RAG**: a NestJS `AgentOrchestrator` adds intent routing, query rewriting, a corrective retrieval loop, grounded generation, and answer verification — wrapping the existing RAG as one typed, permissioned tool among others. No rewrite; every step ships behind a flag and degrades to current behavior.

## 20.2 Target architecture
Single deterministic orchestrator (state machine) in NestJS, behind the existing trust boundary. Modules: IntentRouter, QueryRewriter, QueryPlanner, RetrieverTool, ContextEvaluator, AnswerGenerator, AnswerVerifier, ToolRegistry, ModelGateway, plus Guardrail, Memory, Tracing layers. RAG pipeline split into `/v1/embed|retrieve|generate|evaluate` primitives; ChromaDB and Ollama unchanged. (Diagram §2.1; flow §2.2.)

## 20.3 Incremental plan
Eight phases (§4): instrument/baseline → query rewriting → context evaluator → iterative retrieval → intent router → tool calling → answer verifier → hardening. Each is additive, flagged, and independently testable.

## 20.4 Module design
Ten modules specified (§5) with responsibility, TS interface, I/O, errors, and usage. The orchestrator is a bounded state machine; all LLM modules return validated JSON with deterministic fallbacks; all Ollama access funnels through `ModelGateway`.

## 20.5 TypeScript interfaces
Complete contracts in §6: `AgentRequest/Response/Step/Trace`, `ToolDefinition/Call/Result`, `RetrievalQuery/Result/RetrievedChunk`, `ContextEvaluation`, `PlannedStep`, `VerificationResult`, `ModelRequest/Response`, and `AgentStreamEvent`.

## 20.6 Nest.js folder structure
`api/src/agent/{orchestrator,router,planner,tools,evaluators,verifiers,generators,prompts,guardrails,tracing,contracts,dto}` + `rag/` (composable client) + `models/` (gateway). Controller streams SSE and handles confirm; DI wiring and tests in §8.

## 20.7 RAG Pipeline integration
Split `/v1/chat` into primitives; enforce `patientId` server-side; normalize+return scores; add `chunkId`, dedup, metadata (`sourceType`, `docVersion`), `corpusVersion` for cache invalidation. Hybrid search + reranker optional. Keep current chunking (§9).

## 20.8 Ollama integration
Per-task routing through `ModelGateway` (§10): embeddings `nomic-embed-text`; control tasks `phi3:mini` temp 0 JSON; generation temp 0.2 streamed; `plan` optionally `llama3.2:3b`. JSON retry once → deterministic fallback. Timeouts, abort-on-disconnect, keep_alive, downward fallback tier.

## 20.9 Internal prompts
Versioned JSON-output prompts for IntentRouter, QueryRewriter, QueryPlanner, ContextEvaluator, AnswerGenerator (reuses existing grounding rules), AnswerVerifier, ToolSelector — each with input/output examples (§11).

## 20.10 Security strategy
Guardrail layer (§12): treat context as untrusted data, sanitize injection, enforce tenant/patient filters server-side, permission-check every tool, `preview → commit` for all mutations, never expose prompts, always safe refusal on weak evidence. Hard rules enforced in code, not just prompts.

## 20.11 Observability strategy
One `agent_run` + steps + tool_calls per execution (§13) capturing intent, queries, chunk ids+scores, models, tokens, latency, verification, fallbacks, errors. Powers trace view, routing audits, threshold tuning, regression fixtures; PII-aware (ids not text at info level).

## 20.12 Testing strategy
Layered unit/integration/E2E with mocked Ollama/Chroma + nightly live suite (§15): golden dataset, regression gates, prompt schema tests, retrieval tests, security/injection tests, permission/isolation tests. Example cases included.

## 20.13 6-week roadmap
Wk1 foundations/baseline · Wk2 retrieval primitives + rewrite + evaluate · Wk3 CRAG loop + orchestrator · Wk4 router + planner · Wk5 tools + verifier · Wk6 hardening + pilot rollout (§17). Each week: deliverables, files, acceptance, risks, tests.

## 20.14 Recommended MVP
Single-model gateway, 3-route router, query rewriter, retriever tool, cosine context evaluator, 1-retry loop with refusal, grounded generator with citations, basic verifier, structured logs (§19). Defers planner, LLM evaluation/verification, extra tools, model routing, hybrid/rerank, Redis, queues, memory, multi-agent.

## 20.15 Final implementation checklist

**Foundations**
- [ ] `ModelGateway` + `OllamaService` (JSON mode, timeout, 1 retry, token accounting).
- [ ] `agent/contracts/index.ts` (all §6 interfaces).
- [ ] Tracing module + `agent_runs`/`agent_steps`/`tool_calls` migration.
- [ ] Golden set v1 + baseline metrics report.

**RAG pipeline**
- [ ] `/v1/embed`, `/v1/retrieve`, `/v1/generate`, `/v1/evaluate`.
- [ ] Server-side `patientId` enforcement; score normalization; `chunkId`; dedup.
- [ ] Metadata (`sourceType`, `docVersion`) + `corpusVersion` bump on ingest.

**Agent core**
- [ ] `AgentOrchestrator` state machine + `AgentBudget` guard.
- [ ] `IntentRouter` (+heuristic fallback).
- [ ] `QueryRewriter` (+no-op fallback).
- [ ] `ContextEvaluator` (cosine gate; LLM gate later).
- [ ] CRAG loop with bounded attempts + insufficient-evidence refusal.
- [ ] `QueryPlanner` (post-MVP).

**Generation & verification**
- [ ] `AnswerGenerator` (reuse grounding prompt, streamed, citations).
- [ ] `AnswerVerifier` (citation + groundedness; LLM NLI later).

**Tools & safety**
- [ ] `ToolRegistry` + zod I/O schemas + `mutating` flag.
- [ ] `AppointmentTool` (wrap `chat-actions`), `PatientRecordTool` (parameterized reads).
- [ ] `PermissionService`; `preview → commit` for all mutations.
- [ ] `SanitizerService` + injection test suite.

**Endpoint & frontend**
- [ ] `POST /chat/sessions/:id/agent` SSE (behind flag) + `/confirm`.
- [ ] `PatientScopeGuard`, `RateLimitGuard`, timeout/abort-on-disconnect.
- [ ] Next.js: render `step`/`preview` events, confirm UI, cancel button, debug trace panel.

**Hardening & rollout**
- [ ] Embedding + retrieval caches keyed by `corpusVersion`; invalidate on re-ingest.
- [ ] Rate limiting + idempotency keys for mutations.
- [ ] Dashboards (latency, tokens, hallucination, retry, refusal rates).
- [ ] Load/soak test passes SLA; injection + isolation E2E green.
- [ ] Flip flags for a pilot clinic; monitor; expand.

**Quality gates (per phase)**
- [ ] No regression vs prior phase on golden-set metrics.
- [ ] Hallucination rate < 3%, citation accuracy ≥ 95% before GA.
- [ ] p95 latency within SLA on CPU-only Ollama.
- [ ] Zero cross-patient/cross-tenant leakage in tests.

---

> **Bottom line:** keep ChromaDB, Ollama, the Fastify RAG service, and the NestJS trust boundary. Add a deterministic orchestrator that *decides, rewrites, retrieves iteratively, generates grounded, and verifies* — wrapping the existing RAG as a tool. Ship phase by phase behind flags, measure against a golden set, and never return a factual claim that the retrieved context does not support.
