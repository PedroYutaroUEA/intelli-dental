# Intelli-Dental Architecture

This document describes the current architecture of Intelli-Dental as of June 2026. It is written as a technical snapshot for academic study: it names the runtime components, data ownership boundaries, RAG/agent control flow, persistence model, security constraints, and observability surfaces that exist in the repository.

Intelli-Dental is a local-first dental clinic CRM with a patient-scoped AI assistant. The system combines classic CRUD workflows (clinics, members, patients, anamneses, documents, appointments, booking links) with an Agentic RAG assistant that can retrieve patient evidence, generate grounded answers, inspect its own execution trace, and execute appointment tools through a confirmation workflow.

## Current Runtime Topology

```text
Browser / Next.js app
  - CRM screens
  - assistant chat
  - RAG trace registry
        |
        | HTTP + JWT
        | X-Clinic-Id
        | SSE for assistant streams
        v
NestJS API
  - identity and clinic trust boundary
  - domain services
  - chat sessions/messages
  - deterministic agent orchestrator
  - trace persistence
        |
        | Drizzle ORM
        v
Postgres
  - relational source of truth
  - chat history
  - agent runs, steps, tools, chunks, evaluations

NestJS API
        |
        | HTTP/SSE + RAG_AUTH_TOKEN
        v
Fastify RAG service
  - ingest
  - embed
  - retrieve
  - generate
  - evaluate
  - legacy chat compatibility
        |
        | embeddings / chat
        v
Ollama

Fastify RAG service
        |
        | vector upsert/query/delete
        v
ChromaDB
```

The frontend never calls `rag-pipeline` directly. The NestJS API is the main trust boundary: it authenticates the user, resolves the active clinic, checks membership, scopes all patient operations, injects the internal RAG bearer token, and records assistant traces.

Default local ports:

| Service | Port | Responsibility |
| --- | ---: | --- |
| `app` | `3567` | Next.js CRM and assistant UI |
| `api` | `4000` | Auth, tenancy, domain API, chat, agent orchestration, tracing |
| `rag` | `3000` | RAG primitives and legacy chat endpoint |
| `postgres` | `5432` | Relational source of truth |
| `chroma` | `8000` | Vector index for patient chunks |
| `adminer` | `8080` | Database inspection |
| `ollama` | `11434` | Local embedding/chat models, normally started on the host |

## Repository Layout

```text
intelli-dental/
├── app/                  # Next.js App Router UI, typed API client, assistant page
├── api/                  # NestJS API, Drizzle schemas/migrations, agent services
├── rag-pipeline/         # Fastify service for RAG primitives and ingestion
├── sample-patient-data/  # Example patient records for demonstrations
├── scripts/              # Local bootstrap and presentation generator
├── docs/                 # Architecture snapshot
├── upgrade-plan-docs/    # Historical design plan for the RAG -> Agentic RAG upgrade
├── docker-compose.yml
└── docker-compose.override.yml
```

The `upgrade-plan-docs/` directory is useful design context, but runtime truth should be verified against `app/`, `api/`, `rag-pipeline/`, and the Drizzle migrations.

## Major Architectural Decisions

| Decision | Current implementation | Reason |
| --- | --- | --- |
| API as trust boundary | All private flows pass through NestJS guards and services. | Prevents direct vector-store/RAG access from the browser and centralizes authorization. |
| Patient-scoped RAG | Retrieval requires `patientId`; Chroma metadata and API checks enforce patient isolation. | Prevents cross-patient leakage in both relational and vector paths. |
| Chroma as derived index | Chunks and embeddings live in Chroma; source records remain in Postgres/filesystem. | Keeps vectors rebuildable from patient documents and snapshots. |
| Agent orchestration in API | `AgentOrchestrator` coordinates router, planner, retriever, evaluator, generator, verifier, tools, and tracing. | The orchestrator needs identity, permissions, patient scope, domain services, and persistence. |
| RAG service as primitive provider | Fastify exposes `/embed`, `/retrieve`, `/generate`, `/evaluate`, while `/chat` remains for legacy compatibility. | Lets the agent control the loop while preserving the older linear RAG path. |
| Human-confirmed mutations | Appointment tools use `preview -> commit` and idempotency keys. | LLM-driven actions must not mutate clinical/operational data without explicit user confirmation. |
| Persisted observability | Every agent execution creates `agent_runs`, `agent_steps`, `retrieved_chunks`, `agent_evaluations`, and optional `tool_calls`. | Supports academic inspection, debugging, regression tests, and future quality dashboards. |

## Frontend Architecture

The frontend in `app/` is a Next.js App Router application using React, TypeScript, Tailwind, Radix/shadcn-style UI primitives, and `lucide-react` icons.

Important files and boundaries:

| File or folder | Responsibility |
| --- | --- |
| `app/lib/api-client.ts` | Typed client for all API calls, including SSE parsing for assistant streams. |
| `app/app/assistant/page.tsx` | Patient-scoped assistant UI, chat, inline orchestration details, and RAG registry table. |
| `app/components/ui/` | Shared UI primitives used across CRM screens. |
| `app/lib/chat-commands.ts` | Local parsing for slash commands such as `/listar`, `/criar`, `/cancelar`. |
| `app/lib/auth-gate.tsx` | Client-side guard that requires a JWT before rendering protected screens. |

Frontend security model:

- JWT is stored in `localStorage` as `dental.token`.
- Active clinic is stored in `localStorage` as `dental.clinicId`.
- Clinic-scoped requests include `X-Clinic-Id`.
- The frontend never receives `RAG_AUTH_TOKEN`.
- The frontend renders assistant trace data returned by the API, but does not decide patient scope or permissions.

Assistant UI behavior:

1. The user selects a patient.
2. The UI reuses the latest chat session for that patient or creates a new session.
3. Historical `chat_messages` are loaded.
4. The RAG registry is loaded through `GET /v1/agent/runs?sessionId=...`.
5. Free-text questions stream through `POST /v1/chat/sessions/:id/agent`.
6. SSE events update the live answer, sources, metrics, debug badges, and preview cards.
7. After `event: done`, the UI fetches the completed trace and refreshes the registry.

The assistant page has two study-oriented observability surfaces:

- Inline "Orquestracao do agente" details per assistant message.
- A visible "Registro RAG" table that lists recent agent runs, status, intent, step count, retrieved evidence count, latency, ordered step summaries, raw step input/output/error JSON, and retrieved chunk scores.

## API Architecture

The API is a NestJS application with Fastify as the HTTP adapter. It uses URI versioning with `v1`, DTO validation, JWT authentication, clinic membership guards, and Drizzle ORM for Postgres access.

Top-level modules:

| Module | Responsibility |
| --- | --- |
| `DbModule` | Postgres pool and Drizzle database handle. |
| `AuthModule` | Signup, login, JWT issuance, current user lookup. |
| `ClinicsModule` | Clinic CRUD, membership, invitation, dentist listing. |
| `PatientsModule` | Clinic-scoped patient profile and timeline. |
| `AnamnesesModule` | Structured anamnesis records and RAG snapshot indexing. |
| `AppointmentsModule` | Appointment lifecycle and status transitions. |
| `BookingModule` | Public single-use booking-token workflow. |
| `DocumentsModule` | Patient document upload, storage, deletion, RAG ingestion. |
| `ChatModule` | Chat sessions/messages and synchronous slash-command actions. |
| `RagModule` | Internal HTTP client for the Fastify RAG service. |
| `ModelsModule` | Ollama-backed model gateway for agent LLM tasks. |
| `AgentModule` | Agentic RAG orchestration, tools, tracing, guardrails, metrics. |

### Tenancy and Authorization

Tenancy is clinic-based:

1. The authenticated user is identified by JWT.
2. The frontend sends the active clinic through `X-Clinic-Id`.
3. `ClinicContextGuard` verifies active, accepted membership in that clinic.
4. Service methods query by `clinicId` or explicitly assert record ownership.
5. Chat sessions bind `clinicId`, `userId`, and `patientId`.
6. Agent context includes `clinicId`, `userId`, `role`, `sessionId`, `patientId`, and permissions.

This means an LLM or RAG component never gets to choose its own tenant scope. The API resolves scope before agent execution and passes the already-scoped `patientId` to retrieval tools.

## Relational Persistence Model

Postgres is the source of truth. Drizzle schemas live under `api/src/db/schemas/`; migrations live under `api/drizzle/`.

Domain tables:

| Table | Purpose |
| --- | --- |
| `users` | Authenticated application users. |
| `clinics` | Clinic records. |
| `clinic_members` | Membership, roles, invitation status, accepted/active state. |
| `patients` | Clinic-scoped patient records. |
| `anamneses` | Structured clinical anamnesis and consent data. |
| `appointments` | Appointment records and status machine state. |
| `booking_tokens` | Public self-booking links. |
| `patient_documents` | Uploaded document metadata and ingestion status. |
| `chat_sessions` | One conversation context per user/patient/clinic session. |
| `chat_messages` | User/assistant messages, sources, metrics, agent metadata. |
| `chat_session_memory` | Summarized session memory for future assistant context. |

Agent observability tables:

| Table | Purpose |
| --- | --- |
| `agent_runs` | Header row for one agent execution: session, clinic, patient, user, question, intent, fallback flags, latency, error. |
| `agent_steps` | Ordered state-machine steps with type, model, prompt version, tokens, duration, input, output, error. |
| `tool_calls` | Tool invocations, arguments, mode, mutation flag, result/error. |
| `retrieved_chunks` | Chunk IDs, sources, indexes, scores, distances, and associated retrieval step. |
| `agent_evaluations` | Context sufficiency and answer verification payloads. |
| `prompt_versions` | Registered prompt module versions and hashes. |
| `model_configs` | Model configuration records for task-level model choices. |
| `document_versions` | Document/corpus version metadata for future invalidation and rebuild workflows. |
| `user_feedback` | Placeholder for rating/comment feedback on agent runs. |

`chat_messages.agent_run_id` links user-visible assistant answers to the corresponding run trace. This is what allows the UI to show an answer and then inspect the execution that produced it.

## RAG Service Architecture

The `rag-pipeline/` service is a Fastify application. It is intentionally narrower than the API: it performs ingestion, embeddings, vector retrieval, prompt-grounded answer generation, and RAG metrics. It does not own user identity, clinic membership, role checks, or appointment mutations.

RAG endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/health` | Health metadata, configured model, prompt version. |
| `POST /v1/ingest` | Parse files/directories, chunk, embed, and upsert into Chroma. |
| `POST /v1/embed` | Return Ollama embeddings for supplied text. |
| `GET /v1/patients/:patientId/sources` | List indexed Chroma sources for a patient. |
| `DELETE /v1/patients/:patientId/sources` | Delete all or one source from the patient's vector index. |
| `POST /v1/retrieve` | Return scored chunks/hits for a patient-scoped query. |
| `POST /v1/generate` | Stream an answer from supplied chunks/hits. |
| `POST /v1/evaluate` | Compute context relevance, groundedness, answer relevance, per-chunk scores. |
| `POST /v1/chat` | Legacy linear retrieve-generate-evaluate SSE endpoint. |

Ingestion flow:

```text
Document upload or anamnesis snapshot
        |
        v
API validates clinic and patient ownership
        |
        v
API stores bytes or JSON snapshot
        |
        v
API calls RAG /v1/ingest
        |
        v
Loader parses PDF/TXT/JSON/HTML
        |
        v
Chunker creates patient-tagged chunks
        |
        v
Ollama embedding model returns vectors
        |
        v
Chroma stores vectors with patientId/source metadata
```

RAG primitives support both the legacy and agentic paths:

- Legacy path: `/v1/chat` performs retrieve, generate, evaluate in one service call.
- Agentic path: the API calls `/v1/retrieve`, `/v1/generate`, and `/v1/evaluate` separately so the orchestrator can inspect and correct intermediate state.

## Agentic RAG Flow

The agent flow is centered on `api/src/agent/orchestrator/agent-orchestrator.ts`. It is a deterministic state machine with feature-flagged LLM components, bounded budgets, and conservative fallbacks.

High-level state machine:

```text
POST /v1/chat/sessions/:id/agent
        |
        v
Validate chat session, clinic, user, patient
        |
        v
Sanitize question and persist user message
        |
        v
Start agent_run
        |
        v
Intent routing
        |
        +--> direct_answer
        |       return local assistant message
        |
        +--> unsupported
        |       return insufficient-evidence fallback
        |
        +--> action_request
        |       select/execute appointment tool
        |       emit preview for mutating actions
        |
        +--> knowledge_base_search or multi_step_question
                |
                v
          QueryPlanner
                |
                v
          QueryRewriter
                |
                v
          RetrieverTool
             - vector retrieval through RAG /retrieve
             - optional Postgres retrieval fallback/supplement
                |
                v
          ContextEvaluator
                |
                +--> insufficient context
                |       CRAG retry: suggested query or original step question
                |
                v
          AnswerGenerator or RAG /generate
                |
                v
          RAG /evaluate metrics
                |
                v
          AnswerVerifier
                |
                +--> downgrade
                |       insufficient-evidence fallback
                |
                v
          Persist assistant message and finish agent_run
```

The stream emitted by the API includes:

| SSE event | Payload | Meaning |
| --- | --- | --- |
| default `data:` | JSON-stringified token | Incremental assistant answer text. |
| `event: step` | `{ type: "step", step, data? }` | Live orchestration progress when debug events are enabled. |
| `event: sources` | source references | Retrieved sources for citation display. |
| `event: metrics` | RAG-Triad metrics | Context relevance, groundedness, answer relevance, per-chunk relevance. |
| `event: preview` | tool call and render payload | Mutating action proposed for user confirmation. |
| `event: done` | `{ agentRunId }` | Completion signal and trace link. |
| `event: error` | safe error code/message | User-safe failure message. |

### Agent Components

| Component | Responsibility |
| --- | --- |
| `AgentOrchestrator` | State machine, budgets, fallbacks, persistence hooks, SSE emission. |
| `IntentRouterService` | Classifies the request into direct answer, RAG search, multi-step question, action request, unsupported, etc. |
| `QueryPlannerService` | Produces one or more planned retrieval steps. |
| `QueryRewriterService` | Normalizes/expands the user question into search queries. |
| `RetrieverTool` | Calls RAG retrieval, can include Postgres retrieval or fall back to Postgres if RAG fails. |
| `PostgresRetrieverService` | Converts structured patient data into retrievable chunks. |
| `ContextEvaluatorService` | Decides whether retrieved context is sufficient and can suggest a retry query. |
| `AnswerGeneratorService` | Uses the model gateway for streamed answer generation when configured. |
| `AnswerVerifierService` | Checks groundedness/citation conditions and may pass, regenerate, or downgrade. |
| `ToolRegistryService` | Exposes appointment actions as typed, permissioned tools. |
| `ToolSelectorService` | Converts natural language action requests into tool calls. |
| `SanitizerService` | Cleans questions and retrieved chunks before LLM use. |
| `PermissionService` | Checks tool permission strings against the resolved agent context. |
| `AgentTracingService` | Persists runs, steps, chunks, evaluations, tools, prompt versions. |
| `MemoryService` | Reads and updates session memory for future answers. |
| `AgentMetricsService` | Reports aggregate agent metrics. |

### Feature Flags and Budgets

Agent behavior is controlled by environment flags:

| Flag | Default | Effect |
| --- | --- | --- |
| `AGENT_ROUTER_ENABLED` | `true` | Enables intent routing. |
| `AGENT_QUERY_REWRITE_ENABLED` | `true` | Enables query rewriting. |
| `AGENT_CONTEXT_EVALUATOR_ENABLED` | `true` | Enables context sufficiency evaluator. |
| `AGENT_CRAG_ENABLED` | `true` | Enables corrective retry loop. |
| `AGENT_TOOL_CALLING_ENABLED` | `true` | Enables action tools. |
| `AGENT_VERIFIER_ENABLED` | `true` | Enables answer verification. |
| `AGENT_DEBUG_EVENTS_ENABLED` | `false` | Emits live debug `step` events to the UI. |
| `AGENT_RERANK_ENABLED` | `false` | Enables optional RAG reranking through `RetrieverTool`. |

Default budgets:

| Budget | Default | Purpose |
| --- | ---: | --- |
| `AGENT_MAX_LLM_CALLS` | `3` | Caps router/planner/rewrite/generate/verifier LLM usage. |
| `AGENT_MAX_RETRIEVAL_ATTEMPTS` | `1` | Caps CRAG retry attempts beyond the first attempt. |
| `AGENT_MAX_WALL_CLOCK_MS` | `15000` | Caps total agent execution latency. |

When a budget or verification condition fails, the assistant uses a conservative fallback: "Nao encontrei evidencias suficientes nos registros do paciente."

## Tool and Appointment Action Flow

There are two related action paths:

1. Slash commands parsed by the frontend (`/listar`, `/criar`, `/remarcar`, `/cancelar`, `/confirmar`, `/recusar`) and sent to `POST /v1/chat/sessions/:id/actions`.
2. Natural-language action requests routed by the agent and executed through `ToolRegistryService`.

Both paths use the same `ChatActionsService`, which scopes operations to the chat session's patient.

Mutating flow:

```text
User asks for appointment action
        |
        v
Tool selection or slash-command parsing
        |
        v
mode = preview
        |
        v
ChatActionsService validates arguments and returns preview
        |
        v
UI renders Confirmar / Cancelar
        |
        v
mode = commit + confirmation + idempotency key
        |
        v
AppointmentService mutates Postgres
        |
        v
Assistant message records the result
```

Current appointment tool kinds:

| Tool kind | Mutates? | Purpose |
| --- | --- | --- |
| `list_upcoming` | No | List future appointments for the session patient. |
| `create` | Yes | Create a new appointment/request for the session patient. |
| `reschedule` | Yes | Move an existing non-terminal appointment. |
| `cancel` | Yes | Cancel an appointment. |
| `approve` | Yes | Approve a pending booking request. |
| `reject` | Yes | Reject a pending booking request. |

## Observability and Study Registry

The project now has a concrete registry of RAG/agent actions rather than only transient logs.

Backend persistence:

```text
agent_runs
  └── agent_steps
  └── retrieved_chunks
  └── agent_evaluations
  └── tool_calls

chat_messages
  └── agent_run_id -> agent_runs.id
```

Backend read API:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/agent/runs?sessionId=&patientId=&limit=` | Lists hydrated runs visible to the current user/clinic. |
| `GET /v1/agent/runs/:runId` | Returns one hydrated run with steps, chunks, evaluations, and tools. |
| `GET /v1/agent/metrics` | Returns aggregate agent metrics for the active clinic. |

Frontend inspection:

- The assistant page loads the latest run registry when a patient/session is selected.
- The registry refreshes after each streamed assistant answer.
- Each run can be expanded to inspect ordered steps.
- Each step shows label, sequence, duration, model, token counts, summary, raw input/output/error JSON.
- Retrieved evidence cards show chunk ID, source, chunk index, score, and distance.

This is intentionally useful for academic analysis: it exposes how the answer was produced without requiring direct database queries or container log inspection.

## Document and Anamnesis Ingestion

Patient documents are owned by the API, not by the RAG service.

Document upload flow:

1. The frontend uploads files to `DocumentsController`.
2. The API validates JWT, clinic membership, and patient ownership.
3. The file is stored under the configured documents directory.
4. A `patient_documents` row is inserted with `pending`/`processing` state.
5. `DocumentsService` calls `RagService.ingest`.
6. The RAG service parses, chunks, embeds, and writes vectors to Chroma.
7. The API updates the document row to `ready` or `failed`.

Anamnesis flow:

1. A structured anamnesis is created or updated in Postgres.
2. The API writes a JSON snapshot representing the current structured record.
3. The snapshot is ingested as a patient source.
4. Later assistant retrieval can combine vector chunks from files with structured patient chunks from Postgres.

Deleting a document removes the relational metadata, attempts to delete the corresponding Chroma source, and removes the stored file.

## Data Ownership

| Data | Owner | Storage | Notes |
| --- | --- | --- | --- |
| Users, clinics, roles | API | Postgres | Authoritative identity/tenant metadata. |
| Patients, anamneses, appointments | API | Postgres | Business source of truth. |
| Booking tokens | API | Postgres | Public flow controlled by signed/random tokens. |
| Uploaded document metadata | API | Postgres | Includes ingestion status. |
| Uploaded document bytes | API | Filesystem volume | Source material for rebuilds. |
| Chat sessions/messages | API | Postgres | User-visible conversation history. |
| Agent traces/evaluations/tool calls | API | Postgres | Study/debug/audit registry. |
| Embeddings/chunks | RAG service | ChromaDB | Derived index; rebuildable. |
| Model weights | Ollama | Host or Ollama volume | Local LLM/embedding runtime. |

## Security and Safety Boundaries

Implemented safeguards:

- JWT authentication on private routes.
- `X-Clinic-Id` required for clinic-scoped routes.
- Clinic membership resolved server-side by `ClinicContextGuard`.
- Patient ownership checked before document/chat/anamnesis/appointment access.
- API-to-RAG calls use `RAG_AUTH_TOKEN`.
- RAG retrieval requires patient scope.
- DTO validation strips unknown fields and rejects malformed payloads.
- File upload size/count limits are enforced by the API.
- Tool calls are permissioned and typed.
- Mutating tools require confirmation and idempotency keys.
- Agent fallback downgrades weak evidence to an insufficient-evidence answer.
- Prompt versions and step payloads are persisted for traceability.

Important limitations:

- The local RAG bearer token is static; production would need stronger service identity and rotation.
- The system is not a medical diagnosis engine; generated answers are study/assistant outputs.
- Chroma is a derived index and may need rebuild tooling in production.
- Some trace payloads can include sensitive clinical text depending on debug level and stored step output; production observability would need stricter PII redaction policies.
- Tool idempotency is currently in-process for the registry service; production would persist idempotency keys.
- Ollama runs on the host in local development and is reached by containers through `host.docker.internal`.

## Local Development

The backend and infrastructure are Docker-first:

- `docker-compose.yml` defines Postgres, Adminer, Chroma, RAG, and API.
- `docker-compose.override.yml` switches API and RAG to hot-reload development commands.
- Ollama is expected on the host and should listen on `0.0.0.0:11434`.
- The frontend runs on the host with `pnpm dev` from `app/`.

Common service URLs:

| Service | URL |
| --- | --- |
| Frontend | `http://localhost:3567` |
| API | `http://localhost:4000/v1` |
| RAG | `http://localhost:3000/v1` |
| Chroma | `http://localhost:8000` |
| Adminer | `http://localhost:8080` |

## Testing and Verification

API tests live under `api/test/` and cover:

- model gateway behavior
- prompt registry
- query planner
- intent router
- tool registry and selector
- retriever tool and patient isolation
- status machine
- rate-limit guard
- answer generator and verifier
- agent orchestrator
- chat actions

Frontend tests currently focus on chat command parsing under `app/lib/__tests__/`.

RAG metric helpers live under `rag-pipeline/src/metrics/` and are used by both the legacy `/v1/chat` endpoint and the API-orchestrated agent path.

## Architectural Principles

- Keep the API as the trust boundary.
- Keep the frontend as a typed interaction layer.
- Keep patient scope server-resolved and never LLM-selected.
- Store business records in Postgres, not in the vector store.
- Treat Chroma as a derived, rebuildable index.
- Split RAG into primitives so the agent can inspect and correct intermediate state.
- Persist traces and metrics so assistant behavior is explainable.
- Require human confirmation before mutating data through assistant tools.
- Prefer conservative insufficient-evidence fallback over unsupported clinical claims.
- Make every advanced agent capability feature-flagged and budgeted.

