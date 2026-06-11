# 17. Implementation roadmap

> **PoC note:** the six-week roadmap below is the **full post-PoC vision**, kept for completeness. For the academic PoC, follow the three-stage build order in [§0.4](#04-poc-build-order-small-honest) instead — it delivers the agentic loop in days, not weeks, with no new infrastructure. The weeks below are what you would do *after* the PoC proves the concept.

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
