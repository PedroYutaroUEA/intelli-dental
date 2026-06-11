# 1. Diagnosis of the current architecture

## 1.1 How the system works today

The current flow is a **single-shot, non-agentic RAG** pipeline:

```
Next.js (/assistant)
   │  POST /chat/sessions/:id/messages   (JWT, accept: text/event-stream)
   ▼
NestJS API  (trust boundary)
   │  • validates JWT (jwt.strategy.ts)
   │  • verifies patient ∈ user's active clinic (ChatService.getSession)
   │  • injects RAG_AUTH_TOKEN, proxies SSE unchanged (RagService.openChatStream)
   ▼
RAG Pipeline (Fastify :3000)  — POST /v1/chat
   │  1. embed(question)                 → nomic-embed-text (Ollama /api/embeddings)
   │  2. retrieve top-k (k=8)            → ChromaDB query, filter { patientId }
   │  3. (optional) rerank → top-3       → Xenova/bge-reranker-base
   │  4. emit `event: sources`
   │  5. chatStream(system + user)       → phi3:mini (Ollama /api/chat, streamed)
   │  6. emit `data: <token>` per token
   │  7. evaluateTriad(question,answer)  → RAG-Triad metrics, emit `event: metrics`
   │  8. emit `event: done`
   ▼
NestJS persists final answer + sources + metrics → chat_messages
```

Key facts from the code:

| Concern | Current implementation | Reference |
|---|---|---|
| Retrieval | Pure dense vector search, fixed `k=8`, cosine distance | [`retriever.ts`](../rag-pipeline/src/retrieve/retriever.ts) |
| Isolation | ChromaDB metadata filter `{ patientId }` only | [`retriever.ts`](../rag-pipeline/src/retrieve/retriever.ts) |
| Generation | One LLM call, streamed, no tool calls | [`ollamaChat.ts`](../rag-pipeline/src/generate/ollamaChat.ts) |
| Grounding | Prompt rule: "use ONLY CONTEXT", cite `[source:file#idx]`, fallback "I don't know based on the available records." | [`prompt.ts`](../rag-pipeline/src/generate/prompt.ts) |
| Evaluation | RAG-Triad (context relevance, groundedness, answer relevance) computed **after** generation, **non-blocking** | `metrics/evaluate.ts` |
| Actions | Slash commands with `preview → commit`, separate sync endpoint `POST /chat/sessions/:id/actions` | `chat-actions.service.ts` |
| Persistence | `chat_sessions`, `chat_messages` (with per-message metrics columns) | [`schema.ts`](../api/src/db/schema.ts) |

## 1.2 Structural strengths to preserve

- **Trust boundary is correct.** The frontend never touches the RAG service; NestJS injects `RAG_AUTH_TOKEN` and enforces tenancy. This is exactly where the orchestrator belongs.
- **Per-patient isolation already exists** at the vector layer.
- **Metrics already exist** (RAG-Triad). We can reuse them as the *online signal* for a Context Evaluator instead of computing them only post-hoc.
- **The action/preview/commit pattern** is a working confirmation gate — the foundation for safe tool calling.
- **SSE plumbing** end-to-end already works; the agent can stream `step` events over the same channel.

## 1.3 What to keep / modify / create

### Keep as-is
- ChromaDB as the vector store and its `patientId` metadata filter.
- Ollama as the model server; `nomic-embed-text` for embeddings; phi3:mini for the default generator.
- NestJS as the trust boundary and SSE proxy shape.
- The `chat_sessions` / `chat_messages` tables (extended, not replaced).
- The `preview → commit` confirmation UX for mutating actions.

### Modify
- **RAG Pipeline `/v1/chat`** → split into composable primitives (`/v1/retrieve`, `/v1/generate`, `/v1/embed`, `/v1/evaluate`) so the agent can call retrieval *without* triggering generation. Keep `/v1/chat` as a thin "legacy / fast path" that delegates to the agent in `simple` mode.
- **Retriever** → add metadata filters beyond `patientId` (source type, document version), optional **hybrid search**, score normalization, and chunk dedup.
- **System prompt** → keep the grounding rules; move them into a versioned prompt registry.
- **NestJS chat module** → introduce an `AgentOrchestrator` that owns the loop; `/v1/chat` proxy becomes one of several tools.

### Create (new components)
- `AgentOrchestrator`, `IntentRouter`, `QueryRewriter`, `QueryPlanner`, `ContextEvaluator`, `AnswerGenerator`, `AnswerVerifier`.
- `ToolRegistry` + typed tools (`RetrieverTool`, `PatientRecordTool`, `AppointmentTool` wrapping existing chat-actions).
- `ModelGateway` (task-based Ollama routing, JSON mode, retries, timeouts).
- Tracing/observability layer: `agent_runs`, `agent_steps`, `tool_calls` tables.
- Guardrail layer: prompt-injection scrubbing, permission checks per tool, citation enforcement.

---
