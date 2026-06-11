# 9. Integration with the Node.js RAG Pipeline

Goal: turn the monolithic `/v1/chat` into composable primitives so the agent can retrieve without generating, while keeping `/v1/chat` as a legacy fast-path.

## 9.1 New / changed endpoints

| Endpoint | Status | Purpose |
|---|---|---|
| `POST /v1/embed` | new | `{ texts[] } → { vectors[][] }` (cacheable). |
| `POST /v1/retrieve` | new | `{ query, filters:{patientId,...}, k, rerank } → { chunks[] }` with normalized scores. No generation. |
| `POST /v1/generate` | new | `{ question, chunks[], patientId } → SSE tokens`. Pure generation from supplied context. |
| `POST /v1/evaluate` | new | `{ question, chunks[], answer? } → RAG-Triad` (context-relevance always; groundedness/answer-relevance when `answer` present, per-sentence). |
| `POST /v1/chat` | kept | Legacy single-shot; internally `retrieve → generate → evaluate`. |
| `POST /v1/ingest` | kept | Plus metadata/versioning additions below. |

## 9.2 Mandatory changes

- **Split retrieval from generation** (`/v1/retrieve`, `/v1/generate`). Without this the agent cannot run CRAG loops cheaply.
- **Enforce `patientId` filter server-side** even if a caller omits it (defense in depth — reject requests without it).
- **Score normalization & return:** convert cosine distance → `score ∈ [0,1]` and return both. The agent's evaluator needs comparable scores.
- **Citation/source return:** already present (`source`, `index`); add `chunkId` for dedup and trace linking.
- **Chunk deduplication:** when multi-query retrieval merges results, dedup by `chunkId` keeping max score.

## 9.3 Optional (recommended) changes

- **Metadata enrichment at ingest:** store `{ patientId, source, sourceType, chunkIndex, docVersion, ingestedAt }`. `sourceType ∈ {anamnesis, document, appointment}` enables filtered retrieval.
- **Document versioning:** bump a per-patient `corpusVersion` on every ingest; stamp chunks with `docVersion`. Enables cache invalidation (§Phase 8) and "answer from latest only" filters. The anamnesis re-ingest flow already overwrites — formalize it as a version bump + delete-old.
- **Hybrid search:** add a lexical/BM25 pass (e.g. keep a lightweight keyword index) and fuse with dense scores (reciprocal-rank fusion). Helps exact terms (drug names, tooth numbers `36`, `47`).
- **Reranking:** the existing `bge-reranker-base` reranker becomes a post-merge step the agent toggles per query (off by default for latency on CPU).
- **Permission filters:** retrieval filters always include `patientId`; if workspace/tenant scoping expands later, add `clinicId` to chunk metadata too (currently isolation is per-patient, which already implies clinic).

## 9.4 Chunking notes

Keep the current strategy (prose 500/75; JSON 1 record/chunk — see README "Estratégia de chunking"). It is appropriate for short clinical notes. Only revisit if hybrid search shows exact-term misses; then consider smaller overlap for JSON and sentence-window retrieval for prose.

## 9.5 Example: `/v1/retrieve` contract

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
