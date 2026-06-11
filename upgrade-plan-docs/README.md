# Dental-CRM — Migration Plan: RAG → Agentic RAG

> **Status:** Proposal / Architecture RFC
> **Scope:** Evolve the existing per-patient RAG assistant into an **Agentic RAG**, incrementally, without a rewrite.
> **Audience:** Backend (NestJS), RAG pipeline (Node/Fastify), Frontend (Next.js) engineers.
> **Constraints:** Fully local (Ollama + ChromaDB), multi-tenant by clinic, strict per-patient isolation.
>
> ⚠️ **This is an academic proof-of-concept (Oficina 2 / UEA).** The bulk of this document (§2–§18) is the *full reference vision* and is intentionally over-specified so the design is complete. **The PoC only implements the minimal slice defined in [§0](#0-poc-scope-read-this-first).** Production concerns — load tests, dashboards, Redis, queues, rate limiting, golden datasets, SLAs — are **out of scope** and kept only as future reference. When in doubt, build the §0 version, not the §17 version.

This document is grounded in the **actual** Dental-CRM codebase:

- `api/` — NestJS 11 trust boundary. Chat proxy in [`api/src/chat/chat.service.ts`](../api/src/chat/chat.service.ts), RAG client in [`api/src/rag/rag.service.ts`](../api/src/rag/rag.service.ts), schema in [`api/src/db/schema.ts`](../api/src/db/schema.ts).
- `rag-pipeline/` — Fastify service. HTTP surface in [`rag-pipeline/src/server.ts`](../rag-pipeline/src/server.ts), retrieval in [`rag-pipeline/src/retrieve/retriever.ts`](../rag-pipeline/src/retrieve/retriever.ts), generation/prompt in [`rag-pipeline/src/generate/prompt.ts`](../rag-pipeline/src/generate/prompt.ts) and [`rag-pipeline/src/generate/ollamaChat.ts`](../rag-pipeline/src/generate/ollamaChat.ts), metrics in `rag-pipeline/src/metrics/`.
- `app/` — Next.js 15 SSE consumer (`/assistant`).

A key existing asset: the chat already supports **slash-command actions** (`/listar`, `/criar`, `/remarcar`, …) via `POST /chat/sessions/:id/actions` with a `preview → commit` flow. **That is a proto-agent.** The migration formalizes it into a real orchestrator with tools, planning, and verification.

---

## Split documentation index

This folder splits the original `../rag_agent_upgrade_plan.md` into focused files so each part of the Agentic RAG upgrade plan can be tuned independently.

| Section | File |
|---|---|
| [0. PoC scope (read this first)](00-poc-scope.md) | 00-poc-scope.md |
| [1. Diagnosis of the current architecture](01-current-architecture-diagnosis.md) | 01-current-architecture-diagnosis.md |
| [2. Target Agentic RAG architecture](02-target-agentic-rag-architecture.md) | 02-target-agentic-rag-architecture.md |
| [3. Difference between current RAG and Agentic RAG](03-rag-vs-agentic-rag.md) | 03-rag-vs-agentic-rag.md |
| [4. Incremental migration strategy](04-incremental-migration-strategy.md) | 04-incremental-migration-strategy.md |
| [5. Design of the main modules](05-module-design.md) | 05-module-design.md |
| [6. TypeScript contracts](06-typescript-contracts.md) | 06-typescript-contracts.md |
| [7. Complete example flow](07-complete-example-flow.md) | 07-complete-example-flow.md |
| [8. Nest.js integration](08-nestjs-integration.md) | 08-nestjs-integration.md |
| [9. Integration with the Node.js RAG Pipeline](09-rag-pipeline-integration.md) | 09-rag-pipeline-integration.md |
| [10. Integration with Ollama](10-ollama-integration.md) | 10-ollama-integration.md |
| [11. Internal agent prompts](11-internal-agent-prompts.md) | 11-internal-agent-prompts.md |
| [12. Security and guardrails](12-security-guardrails.md) | 12-security-guardrails.md |
| [13. Observability and debugging](13-observability-debugging.md) | 13-observability-debugging.md |
| [14. Success metrics](14-success-metrics.md) | 14-success-metrics.md |
| [15. Testing](15-testing.md) | 15-testing.md |
| [16. Database and persistence plan](16-database-persistence-plan.md) | 16-database-persistence-plan.md |
| [17. Implementation roadmap](17-implementation-roadmap.md) | 17-implementation-roadmap.md |
| [18. Important architectural decisions](18-architectural-decisions.md) | 18-architectural-decisions.md |
| [19. Recommended MVP](19-recommended-mvp.md) | 19-recommended-mvp.md |
| [20. Final deliverable](20-final-deliverable.md) | 20-final-deliverable.md |

## Editing guidance

- Treat `../rag_agent_upgrade_plan.md` as the source snapshot from before the split.
- Tune the smaller files in this directory when refining scope, sequencing, prompts, contracts, or implementation details.
- If a section changes behavior or acceptance criteria, update the related roadmap/MVP files too so the plan stays internally consistent.
