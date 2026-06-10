---
title: RAG Engine & Retrieval Architecture Specification
status: GROUND_TRUTH (Estado Atual / Produção Imutável)
depends_on:
  - 01_core_architecture.md
description: Especificação técnica do motor de recuperação clássico do Intelli-Dental. Contém o contrato original da API REST do Fastify, lógica de chunking prosa/JSON (500/75) e avaliação pós-geração da RAG-Triad por similaridade de cosseno.
---

# Intelli-Dental - RAG-pipeline

A minimal Retrieval-Augmented Generation service for querying patient data with
**Ollama + LLaMA 3** and **ChromaDB**. Everything runs in Docker; one
`docker compose up` boots the whole stack.

## Components

| Stage                 | Implementation                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Document ingestion    | PDF (`pdf-parse`), TXT/MD (fs), HTML (`cheerio`), JSON records (one record = one chunk)                                    |
| Chunking              | `RecursiveCharacterTextSplitter` — **500 chars / 75 overlap (~15%)** for prose; **1 chunk per record** for structured JSON |
| Embeddings            | `nomic-embed-text` via Ollama `/api/embeddings`                                                                            |
| Vector DB             | ChromaDB (server) with cosine distance, metadata filter on `patientId`                                                     |
| Retrieval             | top-k semantic search (k=8 default)                                                                                        |
| Re-ranking (optional) | `Xenova/bge-reranker-base` cross-encoder via `@xenova/transformers`                                                        |
| Generation            | `phi3:mini` via Ollama `/api/chat`, streamed                                                                               |

### Why these chunk sizes?

Clinical notes are short and dense. **500 characters** ≈ 1–2 short paragraphs:
big enough to retain context for a single finding, small enough that top-k
retrieval stays focused on the question. **75 chars (~15%) overlap** preserves
sentence continuity across boundaries so a fact split between two chunks is
still recoverable. JSON records are already semantically atomic (one
appointment, one finding), so each becomes its own chunk — splitting them
would destroy meaning.

## Architecture

```
┌────────────┐   pull     ┌────────────────────┐
│ ollama-    │──models──▶ │  ollama (LLM)      │◀────┐
│ bootstrap  │            │  :11434            │     │
└────────────┘            └────────────────────┘     │ embed / chat
                                                     │
                          ┌────────────────────┐     │
                          │  rag-app (Node/TS) │─────┘
                          │  Fastify :3000     │─────┐
                          └────────────────────┘     │ upsert / query
                                                     │
                          ┌────────────────────┐     │
                          │  chroma :8000      │◀────┘
                          └────────────────────┘
```

## API REST do serviço RAG

Base URL: `http://localhost:3000`

### `GET /v1/health`

Retorna status da conexão com Ollama e ChromaDB.

```json
{
  "ok": true,
  "ollama": "http://...",
  "chroma": "http://...",
  "model": "phi3:mini"
}
```

### `POST /v1/ingest`

Ingere documentos de um paciente no ChromaDB.

```json
{ "patientId": "uuid", "dir": "data/sample/patient-001" }
```

`dir` ou `file` ou `files[]` é obrigatório. Retorna `{ "docs": N, "chunks": M }`.

### `POST /v1/chat` — SSE

Responde a uma pergunta com streaming Server-Sent Events.

```json
{ "patientId": "uuid", "question": "...", "k": 8, "rerank": false }
```

Eventos emitidos:

| Evento            | Payload                                                       | Descrição               |
| ----------------- | ------------------------------------------------------------- | ----------------------- |
| `event: sources`  | `[{source, index, distance}]`                                 | Chunks recuperados      |
| `data: "<token>"` | string                                                        | Tokens gerados pelo LLM |
| `event: metrics`  | `{contextRelevance, groundedness, answerRelevance, perChunk}` | RAG-Triad pós-geração   |
| `event: done`     | `{}`                                                          | Fim do stream           |
| `event: error`    | `{message}`                                                   | Erro durante geração    |

## Decisões técnicas Específicas

### Por que Ollama no host e não no Docker?

Ollama com GPU requer o driver NVIDIA e o Container Toolkit no host. Rodá-lo diretamente no host elimina essa complexidade para o caso de uso acadêmico e permite compartilhar modelos já baixados entre projetos. O `docker-compose.yml` mantém o serviço `ollama` comentado com instruções para ativá-lo caso necessário.

### Por que ChromaDB como vetor store?

ChromaDB oferece filtragem de metadados nativa (usada para o isolamento por `patientId`), zero configuração de infraestrutura extra, e um cliente JavaScript oficial. Alternativas como pgvector exigiriam extensão no Postgres e perderiam a separação de preocupações entre o banco relacional e o vetor store.

### Estratégia de chunking: 500 chars / 75 overlap

Notas clínicas são curtas e densas. **500 caracteres** ≈ 1–2 parágrafos curtos: grande o suficiente para reter contexto de um achado, pequeno o suficiente para que o top-k permaneça focado na pergunta. **75 chars (~15%) de overlap** preserva continuidade entre fronteiras de chunks, tornando fatos divididos ainda recuperáveis. Registros JSON (anamnese, agendamentos) são semanticamente atômicos — cada registro vira um único chunk para não destruir o significado.

## Notes / limitations

- Patient isolation is enforced via Chroma metadata filter on `patientId`.
  Do not bypass that filter in custom queries.
- Answers are **not medical advice**; the system prompt enforces this.
- OCR for scanned PDFs is out of scope; only text-extractable PDFs work.
- Re-ranker downloads ~270 MB on first use (cached in the container layer).
