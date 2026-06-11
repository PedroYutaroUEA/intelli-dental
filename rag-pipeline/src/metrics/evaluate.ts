import { embed } from "../embed/ollamaEmbeddings.js";
import type { QueryHit } from "../store/chromaClient.js";
import { clamp01, cosine, splitSentences } from "./math.js";

export interface TriadMetrics {
  /** Mean cross-encoder relevance of the (already-selected) context to the question, in [0,1]. */
  contextRelevance: number;
  /** Mean over answer sentences of the max cosine vs any chunk embedding, in [0,1]. */
  groundedness: number;
  /** Cosine similarity between the question and answer embeddings, in [0,1]. */
  answerRelevance: number;
  /** Per-chunk relevance score, aligned with the order of `hits`. */
  perChunk: number[];
}

/**
 * Heuristic RAG-Triad evaluator. No LLM-as-judge calls — uses the BGE
 * cross-encoder reranker for context relevance and Ollama embeddings for
 * groundedness / answer relevance. Designed to fail soft: the caller wraps
 * this in try/catch and keeps streaming the answer regardless.
 */
export async function evaluateTriad(args: {
  question: string;
  answer?: string;
  hits: QueryHit[];
}): Promise<TriadMetrics> {
  const { question, hits } = args;
  const answer = args.answer ?? "";
  const docs = hits.map((h) => h.document);

  // We need embeddings for: question and every chunk. Answer is included only
  // when present so context-only evaluation can run before generation.
  const sentences = splitSentences(answer);
  const hasAnswer = answer.trim().length > 0;
  const embedTargets: string[] = hasAnswer ? [question, answer, ...docs] : [question, ...docs];
  const embeddings = await embed(embedTargets);
  const qEmb = embeddings[0]!;
  const aEmb = hasAnswer ? embeddings[1]! : null;
  const chunkEmbs = embeddings.slice(hasAnswer ? 2 : 1);

  // Context relevance: similarity(question, each selected chunk) in [0,1].
  const perChunk = chunkEmbs.map((cEmb) => clamp01(cosine(qEmb, cEmb)));

  const contextRelevance =
    perChunk.length > 0 ? perChunk.reduce((s, x) => s + x, 0) / perChunk.length : 0;

  // Cosine of normalized embeddings is in [-1, 1]; clamp to [0, 1].
  const answerRelevance = aEmb ? clamp01(cosine(qEmb, aEmb)) : 0;

  let groundedness = 0;
  if (sentences.length > 0 && chunkEmbs.length > 0) {
    // Embed each answer sentence separately so groundedness reflects per-claim support.
    const sentEmbs = await embed(sentences);
    let sum = 0;
    for (const sEmb of sentEmbs) {
      let best = 0;
      for (const cEmb of chunkEmbs) {
        const sim = cosine(sEmb, cEmb);
        if (sim > best) best = sim;
      }
      sum += clamp01(best);
    }
    groundedness = sum / sentEmbs.length;
  }

  return { contextRelevance, groundedness, answerRelevance, perChunk };
}
