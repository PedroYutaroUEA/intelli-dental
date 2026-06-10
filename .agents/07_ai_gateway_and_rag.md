---
title: AI Gateway, Composable RAG Primitives & Ollama Controller
status: TARGET_SPEC (Plano de Evolução / Arquitetura Futura)
depends_on:
  - 02_rag_engine_spec.md
  - 05_agent_data_contracts.md
description: Detalha o desacoplamento do microsserviço Fastify em primitivas atômicas (`/v1/retrieve`, `/v1/generate`, `/v1/evaluate`) e rege o comportamento do `ModelGateway` no NestJS (estruturação de JSON outputs, roteamento por tarefas locais, tratamento de retries e fallbacks de hardware).
---

# 1. Integration with the Node.js RAG Pipeline

Goal: turn the monolithic `/v1/chat` into composable primitives so the agent can retrieve without generating, while keeping `/v1/chat` as a legacy fast-path.

## 1.1 New / changed endpoints

| Endpoint            | Status | Purpose                                                                                                                                      |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/embed`    | new    | `{ texts[] } → { vectors[][] }` (cacheable).                                                                                                 |
| `POST /v1/retrieve` | new    | `{ query, filters:{patientId,...}, k, rerank } → { chunks[] }` with normalized scores. No generation.                                        |
| `POST /v1/generate` | new    | `{ question, chunks[], patientId } → SSE tokens`. Pure generation from supplied context.                                                     |
| `POST /v1/evaluate` | new    | `{ question, chunks[], answer? } → RAG-Triad` (context-relevance always; groundedness/answer-relevance when `answer` present, per-sentence). |
| `POST /v1/chat`     | kept   | Legacy single-shot; internally `retrieve → generate → evaluate`.                                                                             |
| `POST /v1/ingest`   | kept   | Plus metadata/versioning additions below.                                                                                                    |

## 1.2 Mandatory changes

- **Split retrieval from generation** (`/v1/retrieve`, `/v1/generate`). Without this the agent cannot run CRAG loops cheaply.
- **Enforce `patientId` filter server-side** even if a caller omits it (defense in depth — reject requests without it).
- **Score normalization & return:** convert cosine distance → `score ∈ [0,1]` and return both. The agent's evaluator needs comparable scores.
- **Citation/source return:** already present (`source`, `index`); add `chunkId` for dedup and trace linking.
- **Chunk deduplication:** when multi-query retrieval merges results, dedup by `chunkId` keeping max score.

## 1.3 Optional (recommended) changes

- **Metadata enrichment at ingest:** store `{ patientId, source, sourceType, chunkIndex, docVersion, ingestedAt }`. `sourceType ∈ {anamnesis, document, appointment}` enables filtered retrieval.
- **Document versioning:** bump a per-patient `corpusVersion` on every ingest; stamp chunks with `docVersion`. Enables cache invalidation (§Phase 8) and "answer from latest only" filters. The anamnesis re-ingest flow already overwrites — formalize it as a version bump + delete-old.
- **Hybrid search:** add a lexical/BM25 pass (e.g. keep a lightweight keyword index) and fuse with dense scores (reciprocal-rank fusion). Helps exact terms (drug names, tooth numbers `36`, `47`).
- **Reranking:** the existing `bge-reranker-base` reranker becomes a post-merge step the agent toggles per query (off by default for latency on CPU).
- **Permission filters:** retrieval filters always include `patientId`; if workspace/tenant scoping expands later, add `clinicId` to chunk metadata too (currently isolation is per-patient, which already implies clinic).

## 1.4 Chunking notes

Keep the current strategy (prose 500/75; JSON 1 record/chunk — see README "Estratégia de chunking"). It is appropriate for short clinical notes. Only revisit if hybrid search shows exact-term misses; then consider smaller overlap for JSON and sentence-window retrieval for prose.

## 1.5 Example: `/v1/retrieve` contract

```jsonc
// request
{ "query": "gengivite recorrente", "filters": { "patientId": "pat_7", "sourceTypes": ["anamnesis","document"] }, "k": 8, "rerank": false }
// response
{ "chunks": [
    { "chunkId":"anamnesis.txt#3", "document":"...", "source":"anamnesis.txt",
      "index":3, "distance":0.19, "score":0.81, "metadata":{ "sourceType":"anamnesis","docVersion":4 } }
  ], "queryEcho":"gengivite recorrente", "tookMs": 612 }
```

---

# 2. Integration with Ollama

All Ollama access goes through `ModelGateway` → `OllamaService`. No module calls Ollama directly. This centralizes routing, JSON mode, retries, timeouts, and token accounting, and makes model replacement a config change.

## 2.1 Per-task model routing

| Task          | Default model                        | Temp | JSON          | Notes                                          |
| ------------- | ------------------------------------ | ---- | ------------- | ---------------------------------------------- |
| `embed`       | `nomic-embed-text`                   | —    | —             | unchanged; cacheable.                          |
| `intent`      | `phi3:mini`                          | 0    | yes           | tiny output; cheap.                            |
| `rewrite`     | `phi3:mini`                          | 0    | yes           | could use `llama3.2:3b` for better paraphrase. |
| `plan`        | `llama3.2:3b` (fallback `phi3:mini`) | 0    | yes           | benefits from a slightly stronger model.       |
| `evaluate`    | `phi3:mini`                          | 0    | yes           | only on borderline (cosine first).             |
| `generate`    | `phi3:mini`                          | 0.2  | no (streamed) | the user-facing answer; keep current model.    |
| `verify`      | `phi3:mini`                          | 0    | yes           | NLI-style faithfulness, only on borderline.    |
| `tool_select` | `phi3:mini`                          | 0    | yes           | constrained to registered tool names.          |

Routing is a map in config so each task can be swapped: `MODEL_TASK_PLAN=llama3.2:3b`. The "different model per task" strategy is **optional** — the MVP can use a single model for everything except embeddings.

## 2.2 JSON / structured output

For all control tasks (`intent`, `rewrite`, `plan`, `evaluate`, `verify`, `tool_select`) call Ollama `/api/chat` with `format: "json"` and `stream: false`, then **zod-parse** the result. Example gateway call:

```ts
async complete(req: ModelRequest): Promise<ModelResponse> {
  const model = req.modelOverride ?? this.routeModel(req.task);
  const started = Date.now();
  const body = {
    model,
    messages: req.messages,
    stream: false,
    format: req.json ? 'json' : undefined,
    options: {
      temperature: req.temperature ?? this.defaultTemp(req.task),
      num_predict: req.maxTokens ?? this.defaultMaxTokens(req.task),
    },
  };
  const res = await this.ollama.chat(body, req.timeoutMs ?? this.defaultTimeout(req.task));
  let parsed: unknown;
  if (req.json) parsed = this.parseJsonOrRetry(res.text, req); // retry once with "return ONLY JSON" nudge
  return { text: res.text, parsedJson: parsed, model, tokensIn: res.promptEvalCount,
           tokensOut: res.evalCount, latencyMs: Date.now() - started, fallbackModelUsed: false };
}
```

## 2.3 Retry on invalid responses

- **JSON parse failure:** retry once with a stricter instruction appended (`"Responda APENAS com JSON válido, sem texto extra."`). If it still fails → use the module's deterministic fallback (no-op rewrite, cosine-only evaluation, etc.). Never throw raw parse errors to the user.
- **Schema validation failure (zod):** treated like a parse failure.

## 2.4 Latency & temperature control

- Control tasks: `temperature 0`, small `num_predict` (e.g. 128–256) to bound latency.
- Generation: `temperature 0.2` for natural but grounded prose; cap `num_predict` (e.g. 512).
- Set per-task `timeoutMs`; on timeout use fallback. Abort the Ollama stream when the SSE client disconnects (pass an `AbortSignal` into `fetch`).
- Use Ollama `keep_alive` to keep hot models resident; warm up `phi3:mini` on boot with a 1-token request.

## 2.5 Fallback model tier

```
generate:  phi3:mini  →(timeout/error)→  llama3.2:3b? (only if resident)  →  safe error message
plan:      llama3.2:3b →(unavailable)→   phi3:mini
control:   phi3:mini  →(fail)→           deterministic heuristic (no model)
```

Fallback is **downward to a guaranteed-resident model or a non-LLM heuristic**, never to an external API (the system is fully local).

## 2.6 Local model routing strategy (summary)

1. Embeddings: always `nomic-embed-text` (separate model, cache results).
2. One small generalist (`phi3:mini`) handles all control + generation in the MVP.
3. Promote specific tasks (`plan`, optionally `rewrite`) to `llama3.2:3b` only after measuring quality gains worth the latency on CPU.
4. Keep a single model resident under memory pressure; only run a second model if the host has the RAM/VRAM.
