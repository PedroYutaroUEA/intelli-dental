# 6. TypeScript contracts

Place these in `api/src/agent/contracts/` (one barrel `index.ts`). They are framework-agnostic and reused by services, the controller DTOs, and tests.

```ts
// ───────────────────────── core request / response ─────────────────────────
export interface AgentContext {
  agentRunId: string;
  sessionId: string;
  userId: string;
  clinicId: string;
  patientId: string;
  permissions: string[];          // e.g. ['rag:read','patient:read','appointment:write']
  locale?: string;                // 'pt-BR' default
}

export interface AgentBudget {
  maxLlmCalls: number;            // e.g. 6
  maxRetrievalAttempts: number;   // e.g. 2
  maxWallClockMs: number;         // e.g. 15000
}

export interface AgentRequest {
  question: string;
  context: AgentContext;
  budget: AgentBudget;
  /** present when the user confirms a previously-previewed mutating tool */
  confirm?: { toolCallId: string };
  /** 'simple' bypasses router/planner for legacy compatibility */
  mode?: 'agent' | 'simple';
}

export interface Citation {
  source: string;                 // e.g. 'anamnesis.txt'
  index: number;                  // chunk/record index
  chunkId?: string;
  quote?: string;                 // short supporting span
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
  | 'intent' | 'plan' | 'rewrite' | 'retrieve' | 'evaluate'
  | 'tool' | 'generate' | 'verify' | 'fallback' | 'error';

export interface AgentStep {
  id: string;
  runId: string;
  type: AgentStepType;
  startedAt: string;              // ISO
  finishedAt?: string;
  durationMs?: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  input?: unknown;                // redacted at low log levels
  output?: unknown;               // redacted at low log levels
  error?: { code: string; message: string };
}

export interface AgentTrace {
  id: string;                     // agent_run_id
  question: string;
  intent?: Intent;
  steps: AgentStep[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalLatencyMs: number;
  fallbackUsed: boolean;
}

// ───────────────────────── tools ─────────────────────────
import type { ZodTypeAny } from 'zod';

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;                   // e.g. 'rag.retrieve', 'appointment.create'
  description: string;
  inputSchema: ZodTypeAny;        // zod schema for I
  outputSchema: ZodTypeAny;       // zod schema for O
  requiredPermission: string;     // checked against AgentContext.permissions
  mutating: boolean;              // true ⇒ requires preview + explicit confirm
  handler: (input: I, ctx: AgentContext) => Promise<O>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  mode: 'preview' | 'commit';
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
  patientId: string;              // MANDATORY — never optional
  sourceTypes?: ('anamnesis' | 'document' | 'appointment')[];
  corpusVersion?: number;
}

export interface RetrievalQuery {
  text: string;
  filters: RetrievalFilters;
  k?: number;                     // default config.topK (8)
  rerank?: boolean;
}

export interface RetrievedChunk {
  chunkId: string;
  document: string;
  source: string;
  index: number;
  distance: number;               // raw cosine distance from Chroma
  score: number;                  // normalized 0..1 (1 = most relevant)
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
  score: number;                  // 0..1 aggregate context relevance
  missing: string[];              // aspects not covered by the chunks
  suggestedQuery?: string;        // used to drive the next retrieval attempt
  method: 'cosine' | 'llm' | 'hybrid';
}

export interface PlannedStep {
  id: string;
  question: string;
  dependsOn?: string[];           // ids of prior steps
}

export interface VerificationResult {
  faithful: boolean;
  groundedness: number;           // 0..1
  citationsOk: boolean;
  unsupportedClaims: string[];
  action: 'pass' | 'regenerate' | 'downgrade';
  method: 'cosine' | 'llm' | 'hybrid';
}

// ───────────────────────── model gateway ─────────────────────────
export type ModelTask =
  | 'intent' | 'rewrite' | 'plan' | 'evaluate'
  | 'generate' | 'verify' | 'tool_select';

export interface ModelMessage { role: 'system' | 'user' | 'assistant'; content: string; }

export interface ModelRequest {
  task: ModelTask;
  messages: ModelMessage[];
  json?: boolean;                 // force JSON output (Ollama format:'json')
  temperature?: number;           // default per task (0 for control tasks)
  maxTokens?: number;             // maps to Ollama num_predict
  timeoutMs?: number;
  modelOverride?: string;
}

export interface ModelResponse {
  text: string;
  parsedJson?: unknown;           // present when json=true and parse succeeded
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  fallbackModelUsed: boolean;
}

// ───────────────────────── SSE stream events ─────────────────────────
export type AgentStreamEvent =
  | { type: 'step'; step: AgentStepType; data?: unknown }
  | { type: 'sources'; sources: { source: string; index: number; distance: number }[] }
  | { type: 'token'; token: string }
  | { type: 'preview'; toolCall: ToolCall; render: unknown }
  | { type: 'metrics'; metrics: { contextRelevance: number; groundedness: number; answerRelevance: number } }
  | { type: 'done'; agentRunId: string }
  | { type: 'error'; code: string; message: string };
```

---
