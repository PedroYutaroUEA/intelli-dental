import type { ChatActionDto, ChatActionKind } from '../../chat/dto/chat-action.dto';

export type Intent =
  | 'direct_answer'
  | 'knowledge_base_search'
  | 'database_query'
  | 'document_summary'
  | 'multi_step_question'
  | 'action_request'
  | 'unsupported';

export type AgentIntent = Intent;

export type AgentStepType =
  | 'intent'
  | 'plan'
  | 'rewrite'
  | 'retrieve'
  | 'evaluate'
  | 'tool'
  | 'generate'
  | 'verify'
  | 'fallback'
  | 'error';

export interface AgentContext {
  clinicId: string;
  userId: string;
  role: 'owner' | 'dentist' | 'assistant' | 'receptionist';
  sessionId: string;
  patientId: string;
  agentRunId?: string;
  permissions: string[];
  locale?: string;
}

export interface AgentBudget {
  maxLlmCalls: number;
  maxRetrievalAttempts: number;
  maxWallClockMs: number;
}

export interface AgentRequest {
  question: string;
  context: AgentContext;
  budget: AgentBudget;
  confirm?: { toolCallId: string };
  idempotencyKey?: string;
  mode?: 'agent' | 'simple';
  signal?: AbortSignal;
}

export interface Citation {
  source: string;
  index: number;
  chunkId?: string;
  quote?: string;
}

export interface IntentResult {
  intent: Intent;
  confidence: number;
  needsRetrieval: boolean;
  needsTool: boolean;
  reason: string;
  action?: ChatActionDto;
  localMessage?: string;
  modelUsage?: ModelUsage;
}

export interface RewriteResult {
  queries: string[];
  normalizedEntities?: Record<string, string>;
  modelUsage?: ModelUsage;
}

export interface RetrievedChunk {
  chunkId: string;
  document: string;
  source: string;
  index: number;
  distance: number;
  score: number;
  metadata: Record<string, unknown>;
}

export interface ContextEvaluation {
  sufficient: boolean;
  score: number;
  missing: string[];
  suggestedQuery?: string;
  method: 'cosine' | 'llm' | 'hybrid';
  modelUsage?: ModelUsage;
}

export interface VerificationResult {
  faithful: boolean;
  groundedness: number;
  citationsOk: boolean;
  unsupportedClaims: string[];
  action: 'pass' | 'regenerate' | 'downgrade';
  method: 'cosine' | 'llm' | 'hybrid';
  modelUsage?: ModelUsage;
}

export interface AgentStep {
  id: string;
  runId: string;
  type: AgentStepType;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  input?: unknown;
  output?: unknown;
  error?: { code: string; message: string };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  mode: 'preview' | 'commit';
}

export interface ToolInputPropertySchema {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
}

export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, ToolInputPropertySchema>;
  required: string[];
  additionalProperties: boolean;
}

export interface ToolManifestExample {
  description?: string;
  mode: 'preview' | 'commit';
  args: Record<string, unknown>;
}

export interface ToolManifestEntry {
  name: string;
  kind: ChatActionKind;
  description: string;
  requiredPermission: string;
  mutating: boolean;
  confirmationRequired: boolean;
  defaultMode: 'preview' | 'commit';
  inputSchema: ToolInputSchema;
  examples: ToolManifestExample[];
}

export interface ToolSelectionResult {
  tool: string | null;
  action?: ChatActionDto;
  missingArgs: string[];
  message?: string;
  data?: unknown;
  modelUsage?: ModelUsage;
}

export type ZodTypeAny = {
  parse?: (input: unknown) => unknown;
  safeParse?: (input: unknown) => unknown;
};

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: ZodTypeAny;
  outputSchema: ZodTypeAny;
  requiredPermission: string;
  mutating: boolean;
  handler: (input: I, ctx: AgentContext) => Promise<O>;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  mutated: boolean;
  requiresConfirmation?: boolean;
}

export type AgentStreamEvent =
  | { type: 'step'; step: AgentStepType; data?: unknown }
  | { type: 'sources'; sources: { source: string; index: number; distance: number; relevance?: number }[] }
  | { type: 'token'; token: string }
  | { type: 'preview'; toolCall: ToolCall; render: unknown }
  | { type: 'metrics'; metrics: { contextRelevance: number | null; groundedness: number | null; answerRelevance: number | null; perChunk?: number[] } }
  | { type: 'done'; agentRunId: string }
  | { type: 'error'; code: string; message: string };

export interface AgentResponse {
  answer: string;
  citations: Citation[];
  intent: Intent;
  verification: VerificationResult;
  fallbackUsed: boolean;
  insufficientEvidence: boolean;
  agentRunId: string;
  trace: AgentTrace;
}

export interface AgentTrace {
  id: string;
  question: string;
  intent?: Intent | string;
  steps: AgentStep[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalLatencyMs: number;
  fallbackUsed: boolean;
}

export interface PlannedStep {
  id: string;
  question: string;
  dependsOn?: string[];
}

export interface QueryPlan {
  steps: PlannedStep[];
  strategy: 'single' | 'sequential';
  modelUsage?: ModelUsage;
}

export interface GeneratedAnswer {
  text: string;
  citations: Citation[];
  tokensIn?: number;
  tokensOut?: number;
  modelUsage?: ModelUsage;
}

export interface RetrievalFilters {
  patientId: string;
  sourceTypes?: ('anamnesis' | 'document' | 'appointment')[];
  corpusVersion?: number;
}

export interface RetrievalQuery {
  text: string;
  filters: RetrievalFilters;
  k?: number;
  rerank?: boolean;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  queryEcho: string;
  tookMs: number;
}

export type ModelTask =
  | 'intent'
  | 'rewrite'
  | 'plan'
  | 'evaluate'
  | 'generate'
  | 'verify'
  | 'tool_select';

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelRequest {
  task: ModelTask;
  messages: ModelMessage[];
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  modelOverride?: string;
  signal?: AbortSignal;
}

export interface ModelResponse {
  text: string;
  parsedJson?: unknown;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  fallbackModelUsed: boolean;
}

export interface ModelUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  fallbackModelUsed: boolean;
}
