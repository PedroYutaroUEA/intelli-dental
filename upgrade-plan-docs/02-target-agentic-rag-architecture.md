# 2. Target Agentic RAG architecture

## 2.1 Component diagram

```
┌────────────────────────────────────────────────────────────────────────────────┐
│                              Next.js App (/assistant)                            │
│   • renders streamed step events (intent, plan, retrieval, answer, citations)    │
│   • renders preview cards + Confirm/Cancel for mutating tool calls               │
└───────────────────────────────┬──────────────────────────────────────────────────┘
                  JWT │ POST /chat/sessions/:id/agent  (SSE: step | token | done)
                      ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│                     NestJS API Gateway / Backend  (TRUST BOUNDARY)               │
│  AuthGuard(JWT) → ClinicScopeGuard → PatientScopeGuard → RateLimit/Idempotency   │
│                                                                                  │
│   ┌──────────────────────────── Agent module (src/agent) ──────────────────────┐ │
│   │                          ┌──────────────────────┐                          │ │
│   │                          │   AgentOrchestrator   │  state machine / loop    │ │
│   │                          └───────────┬──────────┘                          │ │
│   │        ┌──────────────┬──────────────┼───────────────┬───────────────┐     │ │
│   │        ▼              ▼              ▼               ▼               ▼     │ │
│   │  ┌───────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐ ┌──────────┐ │ │
│   │  │IntentRouter│ │QueryRewriter│ │QueryPlanner│ │ContextEval. │ │AnswerGen │ │ │
│   │  └───────────┘ └────────────┘ └────────────┘ └─────────────┘ └────┬─────┘ │ │
│   │        │                                            ▲              │       │ │
│   │        │                                            │         ┌────▼─────┐ │ │
│   │        │                                            │         │AnswerVer.│ │ │
│   │        ▼                                            │         └──────────┘ │ │
│   │  ┌──────────────┐   selects   ┌──────────────────────────────┐            │ │
│   │  │ ToolRegistry │◀───────────▶│  Tools (typed, permissioned) │            │ │
│   │  └──────┬───────┘             │  • RetrieverTool             │            │ │
│   │         │                     │  • PatientRecordTool (SQL)   │            │ │
│   │         │                     │  • AppointmentTool (actions) │            │ │
│   │         │                     │  • DocumentSummaryTool       │            │ │
│   │         │                     └──────────────────────────────┘            │ │
│   │   ┌─────▼───────┐  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐  │ │
│   │   │ Guardrail   │  │ Memory Layer  │  │ Tracing/Obs. │  │ ModelGateway │  │ │
│   │   │ /Permission │  │ (session+sum) │  │ (steps/runs) │  │ (task→model) │  │ │
│   │   └─────────────┘  └───────────────┘  └──────┬───────┘  └──────┬───────┘  │ │
│   └──────────────────────────────────────────────┼─────────────────┼──────────┘ │
└──────────────────┬───────────────────────────────┼─────────────────┼────────────┘
                   │ HTTP (RAG_AUTH_TOKEN)          │ writes           │ HTTP
                   ▼                                ▼                  ▼
   ┌───────────────────────────────┐   ┌────────────────────┐  ┌──────────────────┐
   │   RAG Pipeline (Fastify)      │   │  Postgres :5432    │  │  Ollama :11434   │
   │  /v1/embed                    │   │  agent_runs        │  │  phi3:mini (gen) │
   │  /v1/retrieve  (+filters)     │   │  agent_steps       │  │  llama3.2:3b     │
   │  /v1/generate  (SSE)          │   │  tool_calls        │  │  nomic-embed-text│
   │  /v1/evaluate  (RAG-Triad)    │   │  chat_messages …   │  │  (embeddings)    │
   │  /v1/ingest                   │   └────────────────────┘  └──────────────────┘
   └──────┬──────────────┬─────────┘
          │ upsert/query  │ extract
          ▼               ▼
   ┌──────────────┐  ┌──────────────────┐
   │ ChromaDB     │  │ Document Store   │
   │ :8000        │  │ api/data/docs/…  │
   │ {patientId,  │  │ (PDF/TXT/JSON/   │
   │  source,ver} │  │  HTML)           │
   └──────────────┘  └──────────────────┘
```

## 2.2 Full flow (user question → final answer)

```
1.  User asks a question in /assistant (patient already selected → patientId).
2.  Next.js → POST /chat/sessions/:id/agent  (JWT, SSE).
3.  Guards: JWT valid → clinic scope → patient ∈ clinic → rate limit / idempotency key.
4.  Orchestrator opens an agent_run (agent_run_id) and a trace.
5.  Guardrail pre-scrub: strip/neutralize injection patterns from the raw question.
6.  IntentRouter → { intent, confidence, needs_retrieval, needs_tool }.
        ├─ direct_answer        → skip retrieval, AnswerGenerator (no-context mode, guarded)
        ├─ action_request       → AppointmentTool preview → STREAM preview → await Confirm
        ├─ database_query       → PatientRecordTool (parameterized SQL, tenant-scoped)
        ├─ knowledge_base_search→ RAG path (below)
        ├─ multi_step_question  → QueryPlanner → sub-steps, each may hit RAG/tools
        └─ unsupported          → safe refusal
7.  (RAG path) QueryRewriter → 1..N normalized/expanded queries.
8.  RetrieverTool (per query) → ChromaDB filtered by {patientId, ...} → chunks + scores.
9.  Dedup + merge + (optional) rerank → candidate context.
10. ContextEvaluator → { sufficient: bool, missing: [...], suggestedQuery? }.
        ├─ sufficient=false AND attempts<MAX → loop to step 7 with suggestedQuery
        └─ sufficient=false AND attempts=MAX → fallback "insufficient evidence"
11. AnswerGenerator (streamed) → grounded answer + inline citations [source:file#idx].
12. AnswerVerifier → checks every claim is supported; strips/flags unsupported claims;
        enforces ≥1 citation; on fail → regenerate once or downgrade to safe answer.
13. Orchestrator persists chat_messages (+ sources, metrics), closes agent_run.
14. SSE `event: done`. Frontend renders answer + citations + (debug) trace summary.
```

## 2.3 Streaming contract (extends today's SSE)

The current SSE events (`sources`, `data`, `metrics`, `done`, `error`) are preserved. The agent adds:

| Event | Payload | Purpose |
|---|---|---|
| `event: step` | `{ type: "intent"|"plan"|"rewrite"|"retrieve"|"evaluate"|"verify", data }` | Live progress + debugging UI |
| `event: preview` | `ToolCall` (mutating) | Render Confirm/Cancel card |
| `event: sources` | `[{source,index,distance}]` | **unchanged** |
| `data: "<token>"` | string | **unchanged** (answer tokens) |
| `event: metrics` | RAG-Triad | **unchanged** |
| `event: done` | `{ agentRunId }` | adds run id for trace linking |
| `event: error` | `{ message, code }` | **unchanged** + error code |

Backward compatibility: the legacy `/chat/sessions/:id/messages` endpoint stays, internally delegating to the orchestrator in `simple` mode (router forced to `knowledge_base_search`, no planner, single retrieval) so existing UI keeps working during migration.

---
