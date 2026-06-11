# Intelli-Dental Architecture

Intelli-Dental is a local-first dental clinic CRM with a patient-scoped AI assistant. The repository is organized as three application services plus supporting infrastructure:

- `app/`: Next.js frontend for the clinic CRM and assistant UI.
- `api/`: NestJS backend and primary trust boundary.
- `rag-pipeline/`: Fastify service for document ingestion, retrieval, generation, and RAG evaluation.
- `postgres`: relational system of record.
- `chroma`: vector store for patient document chunks.
- `ollama`: local LLM and embedding runtime, expected to run on the host in development.

The frontend never talks directly to the RAG service. All authenticated product flows go through the NestJS API, which validates identity, active clinic membership, patient scope, and shared-service credentials before calling the RAG service.

## Runtime Topology

```text
Browser / Next.js app
        |
        | HTTP + JWT
        | X-Clinic-Id
        v
NestJS API
        |
        | Drizzle ORM
        v
Postgres

NestJS API
        |
        | HTTP/SSE + RAG_AUTH_TOKEN
        v
Fastify RAG service
        |
        | embeddings / chat
        v
Ollama

Fastify RAG service
        |
        | upsert / query vectors
        v
ChromaDB
```

Default local ports:

| Service | Port | Responsibility |
| --- | ---: | --- |
| `app` | `3567` | Next.js CRM UI |
| `api` | `4000` | Auth, tenancy, domain API, document storage, chat proxy, agent orchestration |
| `rag` | `3000` | RAG ingestion, retrieval, generation, metrics |
| `postgres` | `5432` | Relational data |
| `chroma` | `8000` | Vector index |
| `adminer` | `8080` | Database inspection |
| `ollama` | `11434` | Local models, usually started outside Compose |

## Repository Layout

```text
intelli-dental/
├── app/                  # Next.js 16 / React / Tailwind UI
├── api/                  # NestJS API, Drizzle schemas, migrations, tests
├── rag-pipeline/         # Fastify RAG service and CLI ingestion helpers
├── scripts/              # Local bootstrap scripts
├── docker-compose.yml    # Base local infrastructure and services
└── docker-compose.override.yml
```

The `upgrade-plan-docs/` directory contains planning material for the agentic RAG upgrade. It is useful design context, but runtime behavior should be verified against `app/`, `api/`, `rag-pipeline/`, and the Compose files.

## Frontend Architecture

The frontend in `app/` is a Next.js App Router application. It provides the CRM screens for login, dashboard, clinics, patients, agenda, booking, anamnesis, treatment planning, finance, and the assistant.

Important frontend boundaries:

- `app/lib/api-client.ts` is the typed API client used by UI routes and components.
- JWT is stored in `localStorage` as `dental.token`.
- The active clinic is stored in `localStorage` as `dental.clinicId`.
- API requests include `Authorization: Bearer <token>` and, for clinic-scoped calls, `X-Clinic-Id`.
- `streamChat`/assistant flows consume Server-Sent Events from the API, not from `rag-pipeline`.
- Shared UI primitives live under `app/components/ui/`.

The UI is intentionally thin. It owns interaction state and rendering, while authorization, tenancy checks, persistence, document ingestion, and assistant execution stay server-side.

## API Architecture

The NestJS API is the main trust boundary. It runs on Fastify, enables URI versioning with default version `v1`, applies global DTO validation, registers multipart upload support, and enables CORS for the configured frontend origin.

Top-level modules are wired in `api/src/app.module.ts`:

| Module | Responsibility |
| --- | --- |
| `DbModule` | Postgres connection and Drizzle access |
| `AuthModule` | Signup, login, JWT issuance, current user lookup |
| `ClinicsModule` | Clinics, memberships, invitations, dentists |
| `PatientsModule` | Clinic-scoped patient records |
| `AnamnesesModule` | Structured patient anamnesis data and RAG snapshot indexing |
| `AppointmentsModule` | Appointment lifecycle and status transitions |
| `BookingModule` | Public token-based booking requests |
| `DocumentsModule` | Patient document upload, storage, deletion, background RAG ingestion |
| `ChatModule` | Chat sessions, messages, appointment commands |
| `RagModule` | Internal HTTP client for `rag-pipeline` |
| `ModelsModule` | Ollama-backed model gateway for agent components |
| `AgentModule` | Agentic RAG orchestration, tools, tracing, metrics, guardrails |

### Tenancy and Authorization

Tenancy is clinic-based:

- Users can belong to multiple clinics through `clinic_members`.
- The active clinic is selected by the frontend and sent as `X-Clinic-Id`.
- `ClinicContextGuard` verifies that the authenticated user has an active, accepted membership in that clinic.
- Clinic-scoped services check `clinicId` in database queries before reading or mutating records.
- Patient operations assert that the patient belongs to the active clinic.

This makes the API responsible for enforcing both user identity and clinic data isolation.

### Persistence

Postgres is the source of truth. Drizzle schema exports include:

- `users`
- `clinics`
- `clinic_members`
- `patients`
- `anamneses`
- `appointments`
- `booking_tokens`
- `patient_documents`
- `chat_sessions`
- `chat_messages`
- `chat_session_memory`
- agent observability tables: `agent_runs`, `agent_steps`, `tool_calls`, `retrieved_chunks`, `agent_evaluations`, `user_feedback`, `document_versions`, `prompt_versions`, `model_configs`

Migrations live in `api/drizzle/`. The development Compose override runs `pnpm db:migrate` before starting the API watcher.

## RAG Service Architecture

The RAG service in `rag-pipeline/` is a Fastify application with versioned endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/health` | Reports service, model, and prompt health metadata |
| `POST /v1/ingest` | Loads patient files or directories, chunks content, embeds, and writes to Chroma |
| `POST /v1/embed` | Returns embeddings from Ollama |
| `POST /v1/retrieve` | Retrieves patient-scoped chunks from Chroma, optionally reranked |
| `POST /v1/generate` | Streams an answer from supplied chunks |
| `POST /v1/evaluate` | Computes RAG-Triad style metrics |
| `POST /v1/chat` | Legacy combined retrieve-generate-evaluate SSE flow |

Core pipeline:

```text
File upload / anamnesis snapshot
        |
        v
API stores file or JSON snapshot
        |
        v
API calls RAG /v1/ingest
        |
        v
Loader parses PDF/TXT/JSON/HTML
        |
        v
Chunker creates semantic chunks with patient metadata
        |
        v
Ollama embedding model creates vectors
        |
        v
Chroma stores vectors filtered by patientId/source metadata
```

Question answering:

```text
User question
        |
        v
API validates session, clinic, patient
        |
        v
RAG retrieve filters by patientId and optional source metadata
        |
        v
Optional reranker keeps strongest chunks
        |
        v
Prompt builder injects retrieved context
        |
        v
Ollama chat model streams answer tokens
        |
        v
RAG metrics evaluate context relevance, groundedness, and answer relevance
```

The default models are configured through environment variables:

- `LLM_MODEL`, default `phi3:mini`
- `EMBED_MODEL`, default `nomic-embed-text`
- `AGENT_LLM_MODEL`, default `phi3:mini`
- `AGENT_PLAN_MODEL`, optional
- `AGENT_REWRITE_MODEL`, optional

## Assistant and Agent Flow

The project has two assistant paths:

1. Legacy RAG chat, where the RAG service performs retrieve, generate, stream, and evaluate in one `/v1/chat` call.
2. Agentic RAG, where the API orchestrates planning, retrieval, tool execution, verification, tracing, and persistence while using `rag-pipeline` for retrieval/generation primitives.

The agent path is centered on `AgentOrchestrator`:

```text
Assistant request
        |
        v
Sanitize question and persist user message
        |
        v
Start agent run trace
        |
        v
Intent routing
        |
        +--> direct answer
        +--> unsupported fallback
        +--> action tool, such as appointment commands
        +--> knowledge-base search
                  |
                  v
             Plan query steps
                  |
                  v
             Optional query rewrite
                  |
                  v
             Retrieve chunks through RetrieverTool -> RagService
                  |
                  v
             Evaluate context sufficiency
                  |
                  v
             Generate answer with citations
                  |
                  v
             Evaluate metrics and verify answer
                  |
                  v
             Persist assistant message, metrics, trace data, memory
```

Agent components are feature-flagged so the system can fall back to simpler behavior when router, rewrite, context evaluation, tool calling, or verifier components fail or are disabled. If orchestration fails, the code attempts a legacy RAG fallback.

Tool execution currently supports assistant-driven actions such as appointment workflows. Mutating tool calls use a preview/confirmation pattern so the user can inspect the proposed action before the database is changed.

## Document and Ingestion Flow

Patient documents are owned by the API:

1. The frontend uploads files to the API with the selected clinic context.
2. `DocumentsService` verifies the patient belongs to the active clinic.
3. Files are written under `DOCUMENTS_DIR`, usually mounted as `api/data/documents`.
4. A `patient_documents` row is created with `pending` status.
5. Background ingestion calls `RagService.ingest`.
6. The RAG service parses and chunks the file, embeds chunks with Ollama, and stores vectors in Chroma with `patientId` and source metadata.
7. The API updates document status to `ready` or `failed`.

Deleting a document removes the database row, attempts to delete the source from Chroma, and removes the stored file if present.

## Data Ownership

| Data | Owner | Storage |
| --- | --- | --- |
| Users, clinics, memberships | API | Postgres |
| Patients, anamneses, appointments | API | Postgres |
| Booking tokens | API | Postgres |
| Uploaded document metadata | API | Postgres |
| Uploaded document bytes | API | Filesystem volume |
| Chat sessions and messages | API | Postgres |
| Agent traces, tool calls, evaluations | API | Postgres |
| Embeddings and retrieved chunks | RAG service | ChromaDB |
| LLM model weights | Ollama | Host or Ollama volume |

The RAG service should be treated as an internal capability service. It does not replace the API's authorization or tenancy checks.

## Security Boundaries

Key safeguards:

- JWT authentication is required for private API routes.
- Clinic-scoped routes require a valid `X-Clinic-Id`.
- API services query by `clinicId` and/or assert patient ownership before access.
- The frontend does not receive direct RAG credentials.
- API-to-RAG calls include `RAG_AUTH_TOKEN`.
- RAG retrieval requires a `patientId` and filters vector queries by patient metadata.
- DTO validation uses whitelist mode and rejects unknown properties.
- File uploads have size and count limits at the API server.
- Agent responses can be downgraded to an insufficient-evidence message when context or verification fails.

## Local Development

Development is Docker-first for infrastructure and backend services:

- `docker-compose.yml` defines Postgres, Adminer, Chroma, RAG, and API.
- `docker-compose.override.yml` switches API and RAG to hot-reload development commands.
- The API and RAG services mount local source directories into containers and keep anonymous `node_modules` volumes.
- Ollama is expected to run on the host; containers reach it through `host.docker.internal`.

Common service URLs:

- Frontend: `http://localhost:3567`
- API: `http://localhost:4000/v1`
- RAG: `http://localhost:3000/v1`
- Chroma: `http://localhost:8000`
- Adminer: `http://localhost:8080`

## Testing

The API has Node test files under `api/test/` covering model gateway, prompt registry, query planning, retriever tooling, rate limits, status transitions, and agent orchestration.

The frontend has tests under `app/lib/__tests__/`, currently focused on chat command parsing.

RAG evaluation helpers live in `rag-pipeline/src/metrics/` and are used by both the legacy chat endpoint and agentic flow through the API.

## Architectural Principles

- Keep the API as the trust boundary.
- Keep the frontend as a typed client and interaction layer.
- Keep RAG patient-scoped by requiring `patientId` at retrieval time.
- Store business records in Postgres, not in the vector store.
- Treat Chroma as a derived index that can be rebuilt from documents and snapshots.
- Prefer streaming responses for assistant UX.
- Persist metrics and traces for assistant observability.
- Fall back conservatively when retrieval, context sufficiency, or answer verification is weak.
