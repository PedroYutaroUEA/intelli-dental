# 16. Database and persistence plan

Reuse Postgres + Drizzle (migrations under `api/drizzle/`). Extend the existing `chat_messages` (do not replace) and add agent-specific tables. All new tables carry `clinic_id` + `patient_id` for tenant-scoped queries and audit.

## 16.1 Tables / collections

| Table | Purpose |
|---|---|
| `agent_runs` | One row per agent execution (the trace header). |
| `agent_steps` | Ordered steps within a run (intent, rewrite, retrieve, …). |
| `tool_calls` | Tool invocations (name, args redacted, result, mutated). |
| `retrieved_chunks` | Chunk ids + scores per retrieve step (no raw text). |
| `agent_evaluations` | Context/verification outcomes per run. |
| `user_feedback` | Thumbs up/down + comment, linked to a run. |
| `prompt_versions` | Versioned prompt text + hash per module. |
| `document_versions` | Per-patient corpus/document version bookkeeping. |
| `model_configs` | Per-task model routing + params (audit of what ran). |

`chat_messages` gains: `agentRunId uuid` (FK), `verification jsonb`, `intent text`, `fallbackUsed boolean`.

## 16.2 Initial Drizzle schema (additions)

```ts
// api/src/db/schema.agent.ts  (imported into the main schema barrel)
import { pgTable, uuid, text, timestamp, integer, real, jsonb, boolean, index, pgEnum } from 'drizzle-orm/pg-core';
import { clinics, patients, users, chatSessions } from './schema';

export const agentStepTypeEnum = pgEnum('agent_step_type', [
  'intent','plan','rewrite','retrieve','evaluate','tool','generate','verify','fallback','error',
]);

export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
  clinicId: uuid('clinic_id').notNull().references(() => clinics.id),
  patientId: uuid('patient_id').notNull().references(() => patients.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  question: text('question').notNull(),
  intent: text('intent'),
  fallbackUsed: boolean('fallback_used').notNull().default(false),
  insufficientEvidence: boolean('insufficient_evidence').notNull().default(false),
  totalTokensIn: integer('total_tokens_in').notNull().default(0),
  totalTokensOut: integer('total_tokens_out').notNull().default(0),
  totalLatencyMs: integer('total_latency_ms').notNull().default(0),
  error: jsonb('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  bySession: index('agent_runs_session_idx').on(t.sessionId, t.createdAt),
  byPatient: index('agent_runs_patient_idx').on(t.patientId, t.createdAt),
}));

export const agentSteps = pgTable('agent_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  type: agentStepTypeEnum('type').notNull(),
  model: text('model'),
  promptVersion: text('prompt_version'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  durationMs: integer('duration_ms'),
  input: jsonb('input'),     // redacted at low log levels
  output: jsonb('output'),   // redacted at low log levels
  error: jsonb('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ byRun: index('agent_steps_run_idx').on(t.runId, t.seq) }));

export const toolCalls = pgTable('tool_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  args: jsonb('args'),       // redacted/whitelisted keys only
  mode: text('mode').notNull(),       // 'preview' | 'commit'
  ok: boolean('ok').notNull(),
  mutated: boolean('mutated').notNull().default(false),
  result: jsonb('result'),
  error: jsonb('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ byRun: index('tool_calls_run_idx').on(t.runId) }));

export const retrievedChunks = pgTable('retrieved_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  stepId: uuid('step_id').references(() => agentSteps.id, { onDelete: 'cascade' }),
  chunkId: text('chunk_id').notNull(),
  source: text('source').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  distance: real('distance'),
  score: real('score'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ byRun: index('retrieved_chunks_run_idx').on(t.runId) }));

export const agentEvaluations = pgTable('agent_evaluations', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),            // 'context' | 'verification'
  sufficient: boolean('sufficient'),
  faithful: boolean('faithful'),
  score: real('score'),
  groundedness: real('groundedness'),
  citationsOk: boolean('citations_ok'),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ byRun: index('agent_evaluations_run_idx').on(t.runId) }));

export const userFeedback = pgTable('user_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  rating: integer('rating').notNull(),     // -1 | 1
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const promptVersions = pgTable('prompt_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  module: text('module').notNull(),        // 'intent' | 'rewrite' | ...
  version: text('version').notNull(),
  hash: text('hash').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const documentVersions = pgTable('document_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  patientId: uuid('patient_id').notNull().references(() => patients.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  version: integer('version').notNull(),
  corpusVersion: integer('corpus_version').notNull(),
  chunkCount: integer('chunk_count'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ byPatient: index('document_versions_patient_idx').on(t.patientId, t.version) }));

export const modelConfigs = pgTable('model_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  task: text('task').notNull(),            // ModelTask
  model: text('model').notNull(),
  temperature: real('temperature'),
  maxTokens: integer('max_tokens'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

Generate the migration with `cd api && pnpm db:generate` (mirrors the existing Drizzle workflow); it is applied automatically on `api` container startup.

---
