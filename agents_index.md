---
title: Intelli-Dental System Context & AI Rules Index
status: SYSTEM_DISPATCHER (Maestro de Contexto Global)
depends_on: none
description: Arquivo raiz imutável para indexação de contexto e injeção de regras de arquitetura globais. Força o Lazy Loading de arquivos da pasta .agents/ reduzindo o consumo de tokens.
---

# Intelli-Dental: System Context & AI Rules

Você é um engenheiro de software full-stack especialista em Inteligência Artificial, operando estritamente sob as diretrizes do Spec-Driven Development (SDD). O sistema é o Intelli-Dental, um CRM odontológico multi-tenant robusto com assistente clínico RAG baseado em isolamento local por paciente.
O projeto está evoluindo de um pipeline RAG tradicional para uma arquitetura orquestrada de Agentic RAG.

## REGRAS ARQUITETURAIS INVIOLÁVEIS (NUNCA QUEBRE):
1. **Frontend (/app):** Next.js 15 (App Router), React 19, TypeScript 5, Tailwind CSS v4, shadcn-ui. Nunca gere componentes baseados em classes ou lógicas legadas do Pages Router.
2. **Backend (/api):** NestJS 11 + Drizzle ORM + PostgreSQL 16. O NestJS atua como a fronteira de segurança absoluta (*Trust Boundary*). Proibido sugerir substituições por Prisma ou TypeORM.
3. **Pipeline RAG (/rag-pipeline):** Fastify 4, Ollama (instalado no host), ChromaDB 8. O frontend nunca acessa este serviço diretamente; toda interação passa pelo proxy seguro do NestJS.
4. **Isolamento de Dados:** Filtros baseados em `patientId` são obrigatórios tanto no banco relacional quanto nas buscas vetoriais no ChromaDB.
5. **Dependências Externas:** Não baixe dependências sem nenhum tipo de permissão (a não ser que seja especificado nas instruções dos arquivos em .agents/).

## MAPA DE CONTEXTO E LAZY LOADING (.agents/):
Antes de iniciar qualquer refatoração ou escrita de código, analise o escopo da tarefa enviada pelo usuário e carregue **APENAS** os arquivos estritamente necessários para poupar tokens:

| Se o escopo da tarefa envolver... | Arquivos Necessários para Carregar | Status do Escopo |
| :--- | :--- | :--- |
| Estrutura de diretórios, tabelas atuais do banco ou stack base | `.agents/01_core_architecture.md` | GROUND_TRUTH |
| Ajustar busca vetorial antiga, parâmetros de ingestão ou RAG-Triad | `.agents/02_rag_engine_spec.md` | GROUND_TRUTH |
| Modificar agendamentos, permissões de clínicas ou regras da agenda | `.agents/03_crm_features_spec.md` | GROUND_TRUTH |
| Consultar o cronograma, prioridades do MVP ou o checklist da Sprint | `.agents/04_upgrade_roadmap.md` | TARGET_SPEC |
| Criar novas tabelas de agentes, migrações Drizzle ou interfaces TS | `.agents/05_agent_data_contracts.md` | TARGET_SPEC |
| Modificar o loop do `AgentOrchestrator`, `IntentRouter` ou prompts | `.agents/06_nestjs_agent_core.md` | TARGET_SPEC |
| Alterar o microsserviço Fastify, chamadas ao Ollama ou fallbacks | `.agents/07_ai_gateway_and_rag.md` | TARGET_SPEC |