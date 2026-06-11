# 19. Recommended MVP

The smallest Agentic RAG that delivers value over today's pipeline, while staying safe and cheap.

> **PoC vs MVP:** the academic PoC is a **subset** of this MVP — see [§0](#0-poc-scope-read-this-first). The PoC drops the `ModelGateway`, `QueryRewriter`, LLM router, and the `agent_runs`/`agent_steps` tables, using heuristics + the existing cosine metric only. This MVP is the natural **next step after** the PoC succeeds.

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

---
