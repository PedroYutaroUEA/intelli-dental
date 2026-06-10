---
title: Core Architecture & Data Model
status: GROUND_TRUTH (Estado Atual / Imutável)
depends_on: none
description: Define a topologia de pastas, arquitetura base e as tabelas atuais do banco de dados relacional.
---

# Intelli-Dental - Ground Truth rules

> CRM inteligente para clínicas odontológicas com assistente RAG por paciente.

Intelli-Dental é uma aplicação web de gestão clínica e de pacientes integrada a um serviço privado de **Geração Aumentada por Recuperação (RAG)**. O CRM gerencia clínicas, dentistas, pacientes, agendamentos, anamneses, odontograma e planejamentos de tratamento. O serviço RAG executa localmente (Ollama + ChromaDB) e expõe uma pequena API REST que o backend NestJS proxia, permitindo ao assistente responder perguntas fundamentadas exclusivamente nos registros de **um único paciente**.

## Visão geral

| Aspecto           | Detalhe                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Tipo              | Micro SaaS / Projeto acadêmico                                                                    |
| Domínio           | Odontologia — gestão de clínicas, pacientes e assistente clínico                                  |
| Modelo de tenancy | Multi-tenant (por clínica), com isolamento de dados garantido na camada de banco e no vetor store |
| Execução          | Totalmente local — sem chamadas a APIs externas pagas. LLMs via Ollama                            |

---

## Layout do repositório

```
intelli-dental/
├── app/              # Frontend Next.js 15 / React 19 / TypeScript / Tailwind v4
├── api/              # Backend NestJS 11 / Drizzle / Postgres — trust boundary
├── rag-pipeline/     # Serviço Fastify — ingestão, embeddings, ChromaDB, chat LLM
├── scripts/
│   └── start.sh      # Bootstrap idempotente do stack completo
├── docker-compose.yml
└── docker-compose.override.yml
```

| Caminho                         | Descrição                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [`app/`](app)                   | Interface CRM: dashboard, clientes, agenda, odontograma, anamnese, planejamento, financeiro, empresas, assistente. |
| [`api/`](api)                   | Auth JWT, membros de clínica, pacientes, agendamentos, anamneses, documentos, chat, proxy RAG.                     |
| [`rag-pipeline/`](rag-pipeline) | Ingestão de documentos, embeddings (`nomic-embed-text`), ChromaDB, chat LLaMA / phi3, métricas RAG-Triad.          |

---

## Arquitetura

### Diagrama de componentes

```
┌──────────────────────┐  HTTP   ┌──────────────────────┐  HTTP / SSE  ┌────────────────────────┐
│  Next.js app (app/)  │ ──────▶ │  NestJS API (api/)   │ ───────────▶ │  RAG service           │
│  • UI do CRM         │         │  • auth / clínicas   │              │  Fastify  :3000        │
│  • Chat por paciente │ ◀────── │  • pacientes / docs  │ ◀─────────── │  (rag-pipeline/)       │
└──────────────────────┘  JWT    │  • proxy do chat RAG │  tokens +    └────────┬───────────────┘
                                 └──────────┬───────────┘  sources              │ embed / chat
                                            │                                   ▼
                                            ▼                          ┌────────────────────┐
                                    ┌──────────────┐                   │  Ollama  :11434    │
                                    │ Postgres :5432│                   │  phi3:mini         │
                                    └──────────────┘                   │  nomic-embed-text  │
                                                                       └────────────────────┘
                                                                                ▲
                                                                                │ upsert / query
                                                                       ┌────────┴───────────┐
                                                                       │  ChromaDB  :8000   │
                                                                       └────────────────────┘
```

> O frontend **nunca** se comunica diretamente com o serviço RAG. O isolamento por paciente é aplicado no servidor via filtro de metadados `patientId` no ChromaDB.

### Pipeline RAG detalhado

```
Documento (PDF/TXT/JSON/HTML)
        │
        ▼
  [Loader]  pdf-parse | cheerio | fs
        │
        ▼
  [Chunker]  RecursiveCharacterTextSplitter
             • Prosa:  500 chars / 75 overlap (~15%)
             • JSON:   1 chunk por registro (atomico)
        │
        ▼
  [Embeddings]  nomic-embed-text via Ollama /api/embeddings
        │
        ▼
  [Vector Store]  ChromaDB — cosine distance
                  metadata: { patientId, source, chunkIndex }
        │
   pergunta do usuário
        │
        ▼
  [Retrieval]  top-k semântico (k=8 padrão)
        │
        ▼ (opcional)
  [Re-ranker]  Xenova/bge-reranker-base (cross-encoder)
               mantém top-3 chunks
        │
        ▼
  [Geração]  phi3:mini via Ollama /api/chat — streamed SSE
        │
        ▼
  [Avaliação RAG-Triad]  (pós-geração, não-bloqueante)
       • Context Relevance  — cosine(question_emb, chunk_embs)
       • Groundedness       — cosine por sentença da resposta vs chunks
       • Answer Relevance   — cosine(question_emb, answer_emb)
```

### Modelo de dados

Tabelas principais (Postgres 16, gerenciadas pelo Drizzle ORM):

| Tabela              | Descrição                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `users`             | Usuários do sistema (dentistas, assistentes, recepcionistas)                                         |
| `clinics`           | Clínicas cadastradas (soft-delete)                                                                   |
| `clinic_members`    | Membership + roles (`owner`, `dentist`, `assistant`, `receptionist`)                                 |
| `patients`          | Cadastro de pacientes por clínica (soft-delete, CPF único por clínica)                               |
| `appointments`      | Agendamentos com status (`requested`, `scheduled`, `confirmed`, `completed`, `cancelled`, `no_show`) |
| `anamneses`         | Ficha anamnésica estruturada (alergias, medicações, histórico, consentimento)                        |
| `patient_documents` | Documentos enviados com status de ingestão RAG (`pending`, `processing`, `ready`, `failed`)          |
| `chat_sessions`     | Sessões de chat por paciente / usuário / clínica                                                     |
| `chat_messages`     | Mensagens com fontes, tokens e métricas RAG-Triad por mensagem                                       |
| `booking_tokens`    | Tokens single-use (sha256) para auto-agendamento de pacientes via link público                       |

---

## Stack tecnológico

### Frontend (`app/`)

| Tecnologia            | Versão | Uso                           |
| --------------------- | ------ | ----------------------------- |
| Next.js               | 15     | App Router, RSC, SSE consumer |
| React                 | 19     | UI                            |
| TypeScript            | 5      | Tipagem estática              |
| Tailwind CSS          | v4     | Estilização                   |
| shadcn-ui / Radix     | latest | Componentes acessíveis        |
| react-hook-form + zod | latest | Formulários e validação       |
| lucide-react          | latest | Ícones                        |
| sonner                | latest | Notificações toast            |

### API (`api/`)

| Tecnologia      | Versão | Uso                           |
| --------------- | ------ | ----------------------------- |
| NestJS          | 11     | Framework HTTP / módulos      |
| Drizzle ORM     | latest | Queries type-safe + migrações |
| Postgres        | 16     | Banco relacional principal    |
| JWT (Passport)  | —      | Autenticação stateless        |
| class-validator | latest | Validação de DTOs             |

### RAG Pipeline (`rag-pipeline/`)

| Tecnologia               | Versão  | Uso                                 |
| ------------------------ | ------- | ----------------------------------- |
| Fastify                  | 4       | HTTP server do serviço RAG          |
| ChromaDB (client)        | latest  | Vetor store com filtro de metadados |
| Ollama                   | host    | Servidor de LLMs locais             |
| phi3:mini                | ~2.3 GB | Modelo de geração (LLM)             |
| nomic-embed-text         | ~270 MB | Modelo de embeddings                |
| langchain text splitters | latest  | `RecursiveCharacterTextSplitter`    |
| @xenova/transformers     | latest  | Cross-encoder reranker (opcional)   |
| pdf-parse                | latest  | Extração de texto de PDFs           |
| cheerio                  | latest  | Parser HTML                         |
| zod                      | latest  | Validação de payloads da API        |

---

## Decisões técnicas Globais

### Por que phi3:mini como LLM padrão?

`phi3:mini` (~2.3 GB) roda em CPUs modernas sem GPU dedicada, entrega respostas de qualidade aceitável para domínio clínico em português e inglês, e puxa rápido no primeiro `./scripts/start.sh`. O modelo é configurável via variável de ambiente `LLM_MODEL` para quem quiser usar `llama3.2:3b` ou modelos maiores.

### Avaliação RAG-Triad sem LLM-as-judge

Em vez de um segundo LLM avaliador (caro e lento), o sistema calcula três métricas via similaridade de embeddings:

- **Context Relevance**: `cosine(question_emb, chunk_embs)` — mede se os chunks recuperados são pertinentes.
- **Groundedness**: `cosine(sentence_embs, chunk_embs)` por sentença da resposta — mede se a resposta é suportada pelo contexto.
- **Answer Relevance**: `cosine(question_emb, answer_emb)` — mede se a resposta endereça a pergunta.

Essas métricas são persistidas na tabela `chat_messages` para análise histórica.

### Por que NestJS como API gateway em vez de acesso direto ao RAG?

O NestJS atua como fronteira de segurança: valida o JWT do usuário, verifica que o paciente pertence à clínica do usuário, injeta o `RAG_AUTH_TOKEN` e só então repassa a requisição ao serviço RAG. O frontend nunca vê o token de auth do RAG nem pode acessar dados de outros pacientes.

### Drizzle ORM em vez de Prisma ou TypeORM

Drizzle ORM oferece inferência de tipos 100% em TypeScript sem geração de código, queries type-safe próximas ao SQL puro, e migrações como arquivos SQL versionáveis. Prisma exige um cliente gerado separado; TypeORM tem decorators que conflitam com o sistema de módulos do NestJS 11.

---

## Limitações conhecidas

| Limitação                           | Detalhe                                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OCR não suportado**               | Apenas PDFs com texto extraível funcionam. PDFs escaneados (imagens) são ignorados pelo `pdf-parse`.                                                                               |
| **Sem autenticação no RAG service** | O `RAG_AUTH_TOKEN` é um bearer token simples — não há rotação automática. Não expor a porta `3000` publicamente.                                                                   |
| **Sem multi-idioma explícito**      | O system prompt está em português. Perguntas em inglês funcionam mas a qualidade pode variar com `phi3:mini`.                                                                      |
| **Financeiro incompleto**           | A rota `/financeiro` está em desenvolvimento — apenas scaffold da UI existe.                                                                                                       |
| **Re-ranker intensivo**             | `bge-reranker-base` aumenta latência significativamente em CPU. Desative (`RERANK=false`) se a latência for crítica.                                                               |
| **Sem streaming de ingestão**       | Ingestão de diretórios grandes é síncrona e bloqueia o endpoint `POST /v1/ingest` até concluir.                                                                                    |
| **Volume compartilhado API ↔ RAG**  | `api/data` é montado em ambos os containers. Em produção, substituir por object storage (S3/MinIO).                                                                                |
| **JWT não revogável**               | Tokens expiram em 7 dias. Não há blacklist — logout no cliente simplesmente descarta o token localmente.                                                                           |
| **Ollama no host**                  | O serviço RAG se conecta ao Ollama via `host.docker.internal` / `0.0.0.0:11434`. Em Linux, isso requer `--add-host=host.docker.internal:host-gateway` (já configurado no compose). |