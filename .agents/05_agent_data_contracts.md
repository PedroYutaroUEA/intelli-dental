---
title: Agent System Data Contracts & Drizzle Persistence Schema
status: TARGET_SPEC (Plano de Evolução / Arquitetura Futura)
depends_on:
  - 01_core_architecture.md
description: Centraliza todos os contratos de tipagem TypeScript estritos para o ecossistema de agentes (`AgentContext`, `AgentTrace`, `ToolDefinition`, `AgentStreamEvent`) e define as novas tabelas relacionais de persistência e observabilidade do Drizzle ORM.
---

# 1. TypeScript contracts

Place these in `api/src/agent/contracts/` (one barrel `index.ts`). They are framework-agnostic and reused by services, the controller DTOs, and tests.

```ts
// ───────────────────────── core request / response ─────────────────────────
export interface AgentContext {
  agentRunId: string;
  sessionId: string;
  userId: string;
  clinicId: string;
  patientId: string;
  permissions: string[]; // e.g. ['rag:read','patient:read','appointment:write']
  locale?: string; // 'pt-BR' default
}

export interface AgentBudget {
  maxLlmCalls: number; // e.g. 6
  maxRetrievalAttempts: number; // e.g. 2
  maxWallClockMs: number; // e.g. 15000
}

export interface AgentRequest {
  question: string;
  context: AgentContext;
  budget: AgentBudget;
  /** present when the user confirms a previously-previewed mutating tool */
  confirm?: { toolCallId: string };
  /** 'simple' bypasses router/planner for legacy compatibility */
  mode?: "agent" | "simple";
}

export interface Citation {
  source: string; // e.g. 'anamnesis.txt'
  index: number; // chunk/record index
  chunkId?: string;
  quote?: string; // short supporting span
}

export interface AgentResponse {
  answer: string;
  citations: Citation[];
  intent: Intent;
  verification: VerificationResult;
  fallbackUsed: boolean;
  insufficientEvidence: boolean;
  trace: AgentTrace;
}

// ───────────────────────── tracing ─────────────────────────
export type AgentStepType =
  | "intent"
  | "plan"
  | "rewrite"
  | "retrieve"
  | "evaluate"
  | "tool"
  | "generate"
  | "verify"
  | "fallback"
  | "error";

export interface AgentStep {
  id: string;
  runId: string;
  type: AgentStepType;
  startedAt: string; // ISO
  finishedAt?: string;
  durationMs?: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  input?: unknown; // redacted at low log levels
  output?: unknown; // redacted at low log levels
  error?: { code: string; message: string };
}

export interface AgentTrace {
  id: string; // agent_run_id
  question: string;
  intent?: Intent;
  steps: AgentStep[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalLatencyMs: number;
  fallbackUsed: boolean;
}

// ───────────────────────── tools ─────────────────────────
import type { ZodTypeAny } from "zod";

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string; // e.g. 'rag.retrieve', 'appointment.create'
  description: string;
  inputSchema: ZodTypeAny; // zod schema for I
  outputSchema: ZodTypeAny; // zod schema for O
  requiredPermission: string; // checked against AgentContext.permissions
  mutating: boolean; // true ⇒ requires preview + explicit confirm
  handler: (input: I, ctx: AgentContext) => Promise<O>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  mode: "preview" | "commit";
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  mutated: boolean;
  requiresConfirmation?: boolean; // true when a mutating tool returned a preview
}

// ───────────────────────── retrieval ─────────────────────────
export interface RetrievalFilters {
  patientId: string; // MANDATORY — never optional
  sourceTypes?: ("anamnesis" | "document" | "appointment")[];
  corpusVersion?: number;
}

export interface RetrievalQuery {
  text: string;
  filters: RetrievalFilters;
  k?: number; // default config.topK (8)
  rerank?: boolean;
}

export interface RetrievedChunk {
  chunkId: string;
  document: string;
  source: string;
  index: number;
  distance: number; // raw cosine distance from Chroma
  score: number; // normalized 0..1 (1 = most relevant)
  metadata: Record<string, unknown>;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  queryEcho: string;
  tookMs: number;
}

// ───────────────────────── evaluation / planning / verification ─────────────────────────
export interface ContextEvaluation {
  sufficient: boolean;
  score: number; // 0..1 aggregate context relevance
  missing: string[]; // aspects not covered by the chunks
  suggestedQuery?: string; // used to drive the next retrieval attempt
  method: "cosine" | "llm" | "hybrid";
}

export interface PlannedStep {
  id: string;
  question: string;
  dependsOn?: string[]; // ids of prior steps
}

export interface VerificationResult {
  faithful: boolean;
  groundedness: number; // 0..1
  citationsOk: boolean;
  unsupportedClaims: string[];
  action: "pass" | "regenerate" | "downgrade";
  method: "cosine" | "llm" | "hybrid";
}

// ───────────────────────── model gateway ─────────────────────────
export type ModelTask =
  | "intent"
  | "rewrite"
  | "plan"
  | "evaluate"
  | "generate"
  | "verify"
  | "tool_select";

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  task: ModelTask;
  messages: ModelMessage[];
  json?: boolean; // force JSON output (Ollama format:'json')
  temperature?: number; // default per task (0 for control tasks)
  maxTokens?: number; // maps to Ollama num_predict
  timeoutMs?: number;
  modelOverride?: string;
}

export interface ModelResponse {
  text: string;
  parsedJson?: unknown; // present when json=true and parse succeeded
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  fallbackModelUsed: boolean;
}

// ───────────────────────── SSE stream events ─────────────────────────
export type AgentStreamEvent =
  | { type: "step"; step: AgentStepType; data?: unknown }
  | {
      type: "sources";
      sources: { source: string; index: number; distance: number }[];
    }
  | { type: "token"; token: string }
  | { type: "preview"; toolCall: ToolCall; render: unknown }
  | {
      type: "metrics";
      metrics: {
        contextRelevance: number;
        groundedness: number;
        answerRelevance: number;
      };
    }
  | { type: "done"; agentRunId: string }
  | { type: "error"; code: string; message: string };
```

---

# 2. Database and persistence plan

Reuse Postgres + Drizzle (migrations under `api/drizzle/`). Extend the existing `chat_messages` (do not replace) and add agent-specific tables. All new tables carry `clinic_id` + `patient_id` for tenant-scoped queries and audit.

## 2.1 Tables / collections

| Table               | Purpose                                                    |
| ------------------- | ---------------------------------------------------------- |
| `agent_runs`        | One row per agent execution (the trace header).            |
| `agent_steps`       | Ordered steps within a run (intent, rewrite, retrieve, …). |
| `tool_calls`        | Tool invocations (name, args redacted, result, mutated).   |
| `retrieved_chunks`  | Chunk ids + scores per retrieve step (no raw text).        |
| `agent_evaluations` | Context/verification outcomes per run.                     |
| `user_feedback`     | Thumbs up/down + comment, linked to a run.                 |
| `prompt_versions`   | Versioned prompt text + hash per module.                   |
| `document_versions` | Per-patient corpus/document version bookkeeping.           |
| `model_configs`     | Per-task model routing + params (audit of what ran).       |

`chat_messages` gains: `agentRunId uuid` (FK), `verification jsonb`, `intent text`, `fallbackUsed boolean`.

## 2.2 Initial Drizzle schema (additions)

```ts
// api/src/db/schema.agent.ts  (imported into the main schema barrel)
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  real,
  jsonb,
  boolean,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";
import { clinics, patients, users, chatSessions } from "./schema";

export const agentStepTypeEnum = pgEnum("agent_step_type", [
  "intent",
  "plan",
  "rewrite",
  "retrieve",
  "evaluate",
  "tool",
  "generate",
  "verify",
  "fallback",
  "error",
]);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    question: text("question").notNull(),
    intent: text("intent"),
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    insufficientEvidence: boolean("insufficient_evidence")
      .notNull()
      .default(false),
    totalTokensIn: integer("total_tokens_in").notNull().default(0),
    totalTokensOut: integer("total_tokens_out").notNull().default(0),
    totalLatencyMs: integer("total_latency_ms").notNull().default(0),
    error: jsonb("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    bySession: index("agent_runs_session_idx").on(t.sessionId, t.createdAt),
    byPatient: index("agent_runs_patient_idx").on(t.patientId, t.createdAt),
  }),
);

export const agentSteps = pgTable(
  "agent_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: agentStepTypeEnum("type").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    durationMs: integer("duration_ms"),
    input: jsonb("input"), // redacted at low log levels
    output: jsonb("output"), // redacted at low log levels
    error: jsonb("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({ byRun: index("agent_steps_run_idx").on(t.runId, t.seq) }),
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    args: jsonb("args"), // redacted/whitelisted keys only
    mode: text("mode").notNull(), // 'preview' | 'commit'
    ok: boolean("ok").notNull(),
    mutated: boolean("mutated").notNull().default(false),
    result: jsonb("result"),
    error: jsonb("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({ byRun: index("tool_calls_run_idx").on(t.runId) }),
);

export const retrievedChunks = pgTable(
  "retrieved_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => agentSteps.id, {
      onDelete: "cascade",
    }),
    chunkId: text("chunk_id").notNull(),
    source: text("source").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    distance: real("distance"),
    score: real("score"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({ byRun: index("retrieved_chunks_run_idx").on(t.runId) }),
);

export const agentEvaluations = pgTable(
  "agent_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // 'context' | 'verification'
    sufficient: boolean("sufficient"),
    faithful: boolean("faithful"),
    score: real("score"),
    groundedness: real("groundedness"),
    citationsOk: boolean("citations_ok"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({ byRun: index("agent_evaluations_run_idx").on(t.runId) }),
);

export const userFeedback = pgTable("user_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  rating: integer("rating").notNull(), // -1 | 1
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const promptVersions = pgTable("prompt_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  module: text("module").notNull(), // 'intent' | 'rewrite' | ...
  version: text("version").notNull(),
  hash: text("hash").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    version: integer("version").notNull(),
    corpusVersion: integer("corpus_version").notNull(),
    chunkCount: integer("chunk_count"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    byPatient: index("document_versions_patient_idx").on(
      t.patientId,
      t.version,
    ),
  }),
);

export const modelConfigs = pgTable("model_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  task: text("task").notNull(), // ModelTask
  model: text("model").notNull(),
  temperature: real("temperature"),
  maxTokens: integer("max_tokens"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
```