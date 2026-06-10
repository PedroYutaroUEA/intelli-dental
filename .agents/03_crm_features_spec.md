---
title: CRM Features & Transactional Chat Actions Spec
status: GROUND_TRUTH (Estado Atual / Produção Imutável)
depends_on:
  - 01_core_architecture.md
description: Mapeamento de regras de negócios relacionais do CRM, controle de concorrência de horários e especificação técnica dos comandos por barra (`/listar`, `/criar`) baseados no fluxo transacional síncrono de `preview → commit` via NestJS.
---

# Intelli-Dental - CRM Features Spec

## Funcionalidades

- **Multi-tenant por clínica.** Um usuário pode possuir clínicas e ser membro de clínicas de outros. Roles por clínica (`owner`, `dentist`, `assistant`, `receptionist`) são independentes.
- **Gestão de clínicas** — `/companies`. Troca de contexto entre clínicas.
- **Agenda** — `/calendar`, `/minha-agenda`, `/agendamentos`. Agendamento em nome de qualquer dentista da clínica. Solicitações pendentes (status `requested`) aparecem no topo de `/agendamentos` com ações **Confirmar** / **Recusar**.
- **Auto-agendamento de paciente** — Em `/clients/[id]`, na aba **Consultas**, gere um link single-use (válido por 7 dias). O paciente acessa `/book/<token>` (público), escolhe dentista, data e duração, e cria uma solicitação em status `requested` que a recepção aprova ou recusa.
- **Cadastro de pacientes** com perfil, anamnese, odontograma e planejamento de tratamento — `/clients`, `/clients/[id]/...`.
- **Upload de documentos + ingestão automática.** PDFs, TXT, JSON e HTML anexados a um paciente são armazenados em `api/data/documents/patients/<id>/` e indexados no RAG em background.
- **Anamnese auto-ingerida.** Salvar ou editar uma anamnese grava um snapshot JSON e re-indexa, garantindo que o assistente sempre veja as respostas mais recentes.
- **Assistente por paciente** — `/assistant`. Respostas streamadas via SSE com citações de fontes, escopo estritamente por paciente. Comandos para gerenciar agendamentos diretamente no chat: `/listar`, `/criar`, `/remarcar`, `/cancelar`, `/confirmar`, `/recusar`, `/ajuda`. Cada ação passa por um passo de confirmação (preview → Confirmar) e é registrada no histórico da conversa.
- **Métricas RAG-Triad** persistidas por mensagem (`context_relevance`, `groundedness`, `answer_relevance`).
- **Financeiro** — `/financeiro` (em desenvolvimento).

---

## Gerenciando agendamentos pelo chat

A página `/assistant` aceita **comandos com barra (`/`)** que executam ações no módulo de agendamentos sem sair da conversa. O fluxo é sempre **preview → confirmar**: o chat primeiro mostra um resumo da ação proposta, e a operação só é gravada no banco quando você clica em **Confirmar**.

> **Escopo.** Os comandos atuam exclusivamente sobre o paciente da sessão de chat ativa (selecionado no painel lateral). Não é possível operar em agendamentos de outro paciente pelo chat — o backend rejeita.

Mensagens que **não** começam com `/` continuam usando o RAG SSE normal (perguntas livres sobre anamnese, alergias, medicações, etc.).

### Referência de comandos

| Comando      | Argumentos                                                                   | Descrição                                                                         |
| ------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `/ajuda`     | —                                                                            | Lista todos os comandos disponíveis. Aliases: `/help`.                            |
| `/listar`    | `[limite=N]` ou `[N]` (1–50, padrão 5)                                       | Mostra os próximos agendamentos do paciente. **Não exige confirmação.**           |
| `/criar`     | `dentista=<uuid>` `data=<YYYY-MM-DD HH:mm>` `duracao=<min>` `[motivo="..."]` | Cria uma nova solicitação (status `requested`). Aliases: `/agendar`.              |
| `/remarcar`  | `<appointmentId>` `data=<YYYY-MM-DD HH:mm>` `[duracao=<min>]`                | Move o horário de um agendamento existente (não-terminal).                        |
| `/cancelar`  | `<appointmentId>` `[motivo="..."]`                                           | Cancela um agendamento (soft-cancel).                                             |
| `/confirmar` | `<appointmentId>`                                                            | Aprova uma solicitação pendente (`requested` → `confirmed`). Aliases: `/aprovar`. |
| `/recusar`   | `<appointmentId>` `[motivo="..."]`                                           | Recusa uma solicitação pendente. Aliases: `/rejeitar`.                            |

**Convenções de argumentos**

- `key=value` para todos os parâmetros nomeados.
- Valores com espaço precisam de aspas: `motivo="paciente desistiu"`, `data="2026-05-02 14:00"`.
- `appointmentId` e `dentista` aceitam UUIDs v4 (formato com hífens).
- `data` aceita `YYYY-MM-DD HH:mm` (interpretado no fuso do navegador) **ou** ISO-8601 (`2026-05-02T17:00:00Z`).
- `duracao` é em minutos, inteiro entre 5 e 480.

### Endpoint subjacente

Os comandos do chat chamam `POST /chat/sessions/:id/actions` com `{ kind, mode: "preview" | "commit", args }`. Esse endpoint é **separado** do streaming SSE (`POST /chat/sessions/:id/messages`) — assim a digitação livre continua respondendo via Ollama enquanto as ações de agendamento são síncronas e transacionais.

---
