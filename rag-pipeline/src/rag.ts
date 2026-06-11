import { embed } from "./embed/ollamaEmbeddings.js";
import { chatStream } from "./generate/ollamaChat.js";
import {
  CLINICAL_RAG_PROMPT_VERSION,
  SYSTEM_PROMPT,
  buildUserMessage,
} from "./generate/prompt.js";
import { evaluateTriad, type TriadMetrics } from "./metrics/evaluate.js";
import { rerank } from "./retrieve/reranker.js";
import { retrieve, type RetrieveFilters } from "./retrieve/retriever.js";
import type { QueryHit } from "./store/chromaClient.js";
import { config } from "./config.js";

export interface SourceRef {
  source: string | number | boolean;
  index: string | number | boolean;
  distance: number;
  score?: number;
}

export interface RetrieveForQuestionOptions {
  patientId?: string;
  question?: string;
  query?: string;
  k?: number;
  rerank?: boolean;
  filters?: RetrieveFilters;
}

export interface RetrievedChunk {
  chunkId: string;
  document: string;
  source: string;
  index: number;
  distance: number;
  score: number;
  metadata: Record<string, string | number | boolean>;
}

export interface RetrieveForQuestionResult {
  chunks: RetrievedChunk[];
  queryEcho: string;
  tookMs: number;
  hits: QueryHit[];
  sources: SourceRef[];
}

export interface GenerateAnswerOptions {
  patientId: string;
  question: string;
  hits?: QueryHit[];
  chunks?: RetrievedChunk[];
}

export interface EmbedTextsResult {
  model: string;
  embeddings: number[][];
}

export async function embedTexts(texts: string[]): Promise<EmbedTextsResult> {
  return {
    model: config.embedModel,
    embeddings: await embed(texts),
  };
}

export async function retrieveForQuestion(
  opts: RetrieveForQuestionOptions,
): Promise<RetrieveForQuestionResult> {
  const startedAt = Date.now();
  const patientId = opts.filters?.patientId ?? opts.patientId;
  const query = opts.query ?? opts.question;
  if (!patientId) throw new Error("patientId is required for retrieval");
  if (!query) throw new Error("query is required for retrieval");

  const k = opts.k ?? config.topK;
  const useRerank = opts.rerank ?? config.rerank;
  let hits = await retrieve({
    patientId,
    question: query,
    k,
    filters: opts.filters,
  });
  if (useRerank) hits = await rerank(query, hits, 3);
  hits = dedupeHits(hits);
  const chunks = hits.map(toChunk);
  return {
    chunks,
    queryEcho: query,
    tookMs: Date.now() - startedAt,
    hits,
    sources: toSources(chunks),
  };
}

export function generateAnswerStream(opts: GenerateAnswerOptions): AsyncGenerator<string> {
  const hits = opts.hits ?? opts.chunks?.map(toHit) ?? [];
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: buildUserMessage(opts.question, hits, opts.patientId),
    },
  ];
  return chatStream(messages);
}

export async function evaluateAnswer(args: {
  question: string;
  answer?: string;
  hits: QueryHit[];
}): Promise<TriadMetrics> {
  return evaluateTriad(args);
}

export function getPromptInfo() {
  return { clinicalRagPromptVersion: CLINICAL_RAG_PROMPT_VERSION };
}

function toChunk(hit: QueryHit): RetrievedChunk {
  const source = hit.metadata.source ?? hit.metadata.file ?? "unknown";
  const index = Number(hit.metadata.recordIndex ?? hit.metadata.chunkIndex ?? hit.metadata.index ?? 0);
  return {
    chunkId: hit.id,
    document: hit.document,
    source: String(source),
    index: Number.isFinite(index) ? index : 0,
    distance: hit.distance,
    score: normalizeScore(hit.distance),
    metadata: hit.metadata,
  };
}

function toHit(chunk: RetrievedChunk): QueryHit {
  return {
    id: chunk.chunkId,
    document: chunk.document,
    distance: chunk.distance,
    metadata: {
      ...chunk.metadata,
      source: chunk.source,
      chunkIndex: chunk.index,
    },
  };
}

function toSources(chunks: RetrievedChunk[]): SourceRef[] {
  return chunks.map((chunk) => ({
    source: chunk.source,
    index: chunk.index,
    distance: chunk.distance,
    score: chunk.score,
  }));
}

function dedupeHits(hits: QueryHit[]): QueryHit[] {
  const byId = new Map<string, QueryHit>();
  for (const hit of hits) {
    const prev = byId.get(hit.id);
    if (!prev || normalizeScore(hit.distance) > normalizeScore(prev.distance)) {
      byId.set(hit.id, hit);
    }
  }
  return [...byId.values()].sort((a, b) => normalizeScore(b.distance) - normalizeScore(a.distance));
}

function normalizeScore(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance));
}
