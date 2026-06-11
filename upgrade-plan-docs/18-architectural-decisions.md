# 18. Important architectural decisions

| # | Decision | Options | Pros / Cons | Recommendation |
|---|---|---|---|---|
| 1 | Framework vs custom | Custom state machine **·** LangGraph.js **·** other agent lib | Custom: full control, debuggable, no new dep, but more boilerplate. LangGraph.js: graph primitives + checkpointing, but extra dep, abstraction over a process we want explicit, weaker with small local models. | **Custom deterministic orchestrator** now; revisit LangGraph.js only if graphs get complex. |
| 2 | Workflow engine | Hand-rolled loop **·** LangGraph.js **·** XState | Hand-rolled: simplest, matches our linear+retry shape. XState: formal states/visualization, learning curve. | **Hand-rolled** (the §5.1 state machine). |
| 3 | Single vs multi-agent | Single orchestrator w/ role modules **·** multi-agent supervisor | Single: cheaper, deterministic, easier to secure. Multi-agent: parallelism/specialization, but coordination + cost overhead, brittle on phi3. | **Single orchestrator**; keep planner/critic as modules. |
| 4 | Vector store | Keep **ChromaDB** **·** pgvector **·** Qdrant/Weaviate | Chroma: already integrated, metadata filter, zero new infra. pgvector: one DB, but adds extension + loses separation. Qdrant/Weaviate: richer hybrid/rerank, but new service to operate. | **Keep ChromaDB**; reconsider Qdrant only if hybrid/scale demands it. |
| 5 | Reranker | Off by default **·** always on | bge-reranker improves precision but is CPU-heavy (high latency). | **Per-query toggle, off by default**; enable for hard queries. |
| 6 | Persistent memory | None (session only) **·** summary memory **·** vector memory | None: simplest, fits per-patient scope. Summary: better long chats, small cost. Vector mem: richer, but leakage risk across sessions. | **Session + optional summary** later; no cross-session vector memory (isolation risk). |
| 7 | Models per task | Single model **·** per-task routing | Single: simplest, lower memory. Per-task: quality gains (plan/rewrite), but more RAM + complexity. | **Single `phi3:mini` for MVP**; promote `plan` to `llama3.2:3b` after measuring. |
| 8 | RAG pipeline placement | Keep separate Fastify service **·** fold into NestJS | Separate: clear boundary, independent scaling, reuse existing. Folded: fewer hops, but couples concerns + loses isolation. | **Keep separate**; just add composable endpoints. |
| 9 | Queues for long tasks | Synchronous **·** BullMQ/Redis queue | Sync: simplest; chat is interactive anyway. Queue: needed for heavy ingest/batch eval, adds Redis. | **Sync for chat**; add a queue only for ingest/batch evaluation. |
| 10 | Caching layer | None **·** in-memory **·** Redis | None: simplest. In-memory: fast, per-instance. Redis: shared, survives restarts, new dep. | **In-memory for MVP**, Redis in hardening if multi-instance. |

---
