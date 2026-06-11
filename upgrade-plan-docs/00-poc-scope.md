# 0. PoC scope (read this first)

This is an academic PoC. The goal is to **demonstrate the agentic behaviors end-to-end** on one patient, not to ship a hardened product. Everything below is the complete *binding* scope for the PoC; the rest of the document is reference material the PoC borrows from selectively.

## 0.1 What the PoC must demonstrate (minimal functionalities)

1. **The agent decides** whether a question needs retrieval or is a slash-command action — using a **heuristic router** (no extra LLM call).
2. **Retrieval is a tool** the agent calls (the existing RAG), not a hardcoded step.
3. **The agent checks if the retrieved context is good enough** before answering — using the **cosine context-relevance score the pipeline already computes** (no new LLM call). If it's too weak, it answers with the canonical *"Não encontrei evidências suficientes nos registros do paciente."*
4. **The answer is grounded and cited** — reuse the existing system prompt and `[source:file#idx]` citations.
5. **A light citation check** runs before returning: if a factual answer has zero citations, downgrade to the insufficient-evidence message.
6. **Each run is traceable** via structured logs (one log line per step). **No new tables required** for the PoC.

That is the whole PoC. It turns today's single-shot RAG into a small **decide → retrieve(tool) → check → generate → verify** loop, adding **zero** new LLM calls beyond the existing generation.

## 0.2 Explicitly OUT of scope for the PoC

Keep these as reference only (they live in §2–§18) — do **not** build them for the PoC:

- LLM-based intent router, query rewriter, query planner, LLM context evaluator, LLM answer verifier (§5, §11) → PoC uses heuristics + the existing cosine metric.
- Multi-step planning / sub-questions (§5.4) → PoC is single-step only.
- `ModelGateway` with per-task model routing (§10) → PoC keeps the **single** `phi3:mini` + `nomic-embed-text` already wired.
- New tracing tables `agent_runs` / `agent_steps` / `tool_calls` and the schema in §16 → PoC uses `Logger` only.
- Prompt-injection sanitizer service, permission service, rate limiting, idempotency (§8, §12) → PoC relies on the **existing** trust boundary, JWT guard, and per-patient isolation that are already in place.
- Caching, queues, Redis, hybrid search, reranker-by-default, dashboards, load/soak tests, golden datasets (§13–§17) → none in the PoC.
- LangGraph / any agent framework → PoC is a ~150-line hand-written function in NestJS.

If a task seems to need any of the above, implement the simplest stub or skip it and note why — consistent with the repo's PoC rules in [`.github/copilot-instructions.md`](../.github/copilot-instructions.md).

## 0.3 Minimal architecture (PoC)

Reuse everything that exists. Add **one** small orchestrator service in NestJS. No changes to ChromaDB, Ollama, or the DB schema.

```
Next.js (/assistant)
   │  POST /chat/sessions/:id/agent   (JWT, SSE)   ← new thin route (or reuse existing messages route behind a flag)
   ▼
NestJS  AgentOrchestrator (NEW, ~1 file)
   │  1. heuristicRoute(question)        → 'action' | 'rag'        (no LLM)
   │       └─ 'action' → existing chat-actions.service (preview → commit)   ← already built
   │  2. retrieve via RagService (TOOL)  → chunks + cosine scores
   │  3. contextOk = maxCosine ≥ THRESHOLD                          (reuse pipeline score)
   │       └─ if !contextOk → stream canonical "insufficient evidence" + done
   │  4. generate (existing /v1/chat path or /v1/generate)         ← reuse
   │  5. verify: answer has ≥1 [source:...] citation? else downgrade
   │  6. persist to chat_messages (existing) + Logger trace per step
   ▼
rag-pipeline (Fastify)   ── unchanged except OPTIONAL split of /v1/chat (see §0.4)
   ▼
Ollama (phi3:mini, nomic-embed-text)   ·   ChromaDB { patientId }
```

The only genuinely new code is the orchestrator + a heuristic router helper + a citation check. Routing, isolation, SSE, generation, metrics, and the action/preview/commit flow **already exist**.

## 0.4 PoC build order (small, honest)

Three short stages instead of the 6-week production roadmap in §17:

| Stage | Deliverable | New files | Done when |
|---|---|---|---|
| **A. Orchestrator skeleton** | `AgentOrchestrator` calls existing retrieve → generate and streams SSE; heuristic router sends `/`-commands to the existing actions service. | `api/src/agent/agent.module.ts`, `agent.controller.ts`, `agent.service.ts`, `orchestrator/agent-orchestrator.ts`, `router/heuristic-router.ts` | `/assistant` answers a normal question through the new route, identical to today. |
| **B. Context gate + refusal** | Read the cosine context-relevance score; if below `RAG_CONTEXT_MIN` (env, e.g. `0.35`), stream the canonical insufficient-evidence message instead of generating. | (edits only) + optional `/v1/retrieve` split in rag-pipeline | A question with no supporting records returns the refusal, not a hallucination. |
| **C. Citation check + trace logs** | After generation, if the answer has no `[source:...]` tag, downgrade to refusal. Log one structured line per step (`route`, `chunks`, `topScore`, `contextOk`, `citationsOk`, `latencyMs`). | (edits only) | Logs show the full decision path; an uncited factual answer never reaches the user. |

No feature flags strictly required, but gating the new route behind `AGENT_ENABLED=true` keeps the legacy `/messages` route as a safe fallback during the demo.

## 0.5 Acceptance for the PoC

- A normal clinical question returns a grounded, cited answer (parity with today).
- A question with weak/no evidence returns the canonical refusal (no fabrication).
- A `/`-command still runs the existing preview → commit action flow.
- Logs reconstruct the decision path for any single run.
- No new infra, no new DB tables, no extra Ollama models.

Everything past this is **future work** — see §19 (fuller MVP) and §17 (full vision).

---
