# Roteiro de defesa: componentes do agente no Intelli-Dental

Este documento foi escrito como um roteiro de fala para defesa acadêmica. A ideia não é apenas listar classes, mas explicar por que a arquitetura do agente foi desenhada dessa forma, quais problemas ela resolve e como cada componente contribui para um sistema RAG mais auditável, seguro e útil no domínio odontológico.

## Abertura da explicação

Ao apresentar o módulo de agente deste projeto, eu começaria destacando que o Intelli-Dental não usa o modelo de linguagem como uma entidade autônoma que decide tudo sozinha. A decisão arquitetural central foi manter o controle no backend, dentro de uma máquina de estados determinística implementada em NestJS.

Essa escolha é importante porque o domínio do sistema envolve dados clínicos, dados pessoais, agenda de pacientes e ações que podem alterar registros operacionais. Portanto, o agente precisa ser capaz de usar linguagem natural, mas não pode abrir mão de escopo, autorização, rastreabilidade e validação.

Em termos práticos, o agente é composto por serviços especializados em `api/src/agent`. Cada serviço resolve uma responsabilidade específica: classificar intenção, planejar consulta, reescrever pergunta, recuperar evidência, avaliar contexto, gerar resposta, verificar fundamentação, executar ferramentas e persistir o trace da execução.

## Tese arquitetural do agente

A tese defendida aqui é que o sistema evolui de um RAG linear para um Agentic RAG controlado.

No RAG linear, o fluxo é basicamente:

```text
pergunta -> recuperação vetorial -> prompt -> resposta
```

Esse fluxo funciona para perguntas simples, mas é limitado quando a pergunta exige decisão, múltiplas etapas, validação do contexto ou uso de ferramentas. No Intelli-Dental, o fluxo passa a ser:

```text
pergunta -> roteamento -> planejamento -> reescrita -> recuperação
         -> avaliação -> geração -> verificação -> persistência
```

O ponto mais importante para a defesa é: o agente não é "mais IA" apenas por chamar mais vezes o LLM. Ele é mais robusto porque transforma uma pergunta em uma execução observável, com passos explícitos, orçamento, fallbacks e registro persistido.

## Entrada do agente: `AgentController`

O ponto de entrada do fluxo agentic é o endpoint:

```text
POST /v1/chat/sessions/:id/agent
```

Esse endpoint fica em `AgentController`. Ele recebe a pergunta do usuário, valida a sessão de chat, resolve o paciente da sessão e monta o contexto do agente.

Esse contexto contém:

```text
clinicId
userId
role
sessionId
patientId
permissions
locale
```

Durante a defesa, eu destacaria que isso impede uma falha comum em sistemas com LLM: deixar o modelo "decidir" o paciente, a clínica ou o escopo de acesso. No Intelli-Dental, o LLM nunca escolhe o escopo. O escopo é resolvido antes, por guards e serviços do backend.

O controller também é responsável por transmitir a resposta ao frontend via Server-Sent Events. Isso permite que a interface receba tokens gradualmente, além de eventos estruturados como fontes, métricas, previews de ferramentas e o identificador do `agentRunId`.

## Fachada do módulo: `AgentService`

O `AgentService` funciona como uma fachada sobre o orquestrador. Ele não concentra a lógica complexa; ele prepara valores padrão, principalmente o orçamento da execução, e delega para o `AgentOrchestrator`.

O orçamento padrão inclui:

```text
maxLlmCalls
maxRetrievalAttempts
maxWallClockMs
```

Na defesa, eu explicaria que esse orçamento é uma proteção contra dois riscos típicos de agentes: custo descontrolado e latência indefinida. Mesmo em um projeto local com Ollama, o conceito é relevante academicamente porque mostra que a arquitetura foi pensada para ser controlável.

## Núcleo da execução: `AgentOrchestrator`

O `AgentOrchestrator` é o componente central do módulo. Ele implementa a máquina de estados do agente.

Ele coordena:

- sanitização da pergunta;
- persistência da mensagem do usuário;
- abertura de um `agent_run`;
- classificação de intenção;
- planejamento;
- reescrita de consulta;
- recuperação de evidências;
- avaliação de contexto;
- geração da resposta;
- cálculo de métricas RAG;
- verificação de groundedness;
- execução de ferramentas;
- persistência da resposta e do trace.

Eu defenderia esse componente como o "controlador de fluxo" do agente. Ele não é um agente no sentido de tomar decisões livres e opacas. Ele é um executor determinístico que chama serviços especializados e registra cada transição relevante.

O orquestrador também define fallbacks conservadores. Se o contexto for insuficiente, se a verificação falhar ou se a execução exceder orçamento, o sistema prefere responder que não encontrou evidências suficientes nos registros do paciente. Essa é uma decisão importante para o domínio clínico: é melhor recusar uma resposta do que fabricar uma resposta sem suporte.

## Contratos: `contracts/index.ts`

Os contratos TypeScript definem as estruturas que circulam entre os componentes.

Alguns contratos relevantes são:

```text
AgentRequest
AgentContext
AgentBudget
IntentResult
QueryPlan
RetrievedChunk
ContextEvaluation
VerificationResult
ToolCall
AgentStreamEvent
AgentResponse
```

Na defesa, eu ressaltaria que os contratos tornam explícita a fronteira entre linguagem natural e sistema determinístico. O LLM pode participar de algumas decisões, mas os resultados precisam voltar em estruturas conhecidas e validadas pelo backend.

Isso é especialmente importante em Agentic RAG, porque sem contratos o sistema vira uma cadeia informal de prompts. Com contratos, cada etapa pode ser testada, registrada e substituída.

## Roteamento de intenção: `IntentRouterService` e `HeuristicRouter`

O roteador de intenção decide qual tipo de trabalho a pergunta exige.

Exemplos de intenções:

```text
direct_answer
knowledge_base_search
multi_step_question
action_request
unsupported
```

O papel do roteador é evitar que toda pergunta seja tratada como RAG. Algumas perguntas podem ser respondidas diretamente, algumas devem ser recusadas, algumas exigem busca nos documentos do paciente, e outras representam ações, como criar ou remarcar um agendamento.

Na defesa, eu explicaria que esse roteamento reduz custo e aumenta segurança. Uma pergunta operacional como "remarque a consulta" não deve ir direto para o prompt de resposta clínica. Ela precisa ser transformada em uma chamada de ferramenta com confirmação humana.

O `HeuristicRouter` funciona como uma alternativa determinística ou complementar. Ele ajuda o sistema a degradar de forma previsível quando uma etapa baseada em modelo não está disponível ou falha.

## Planejamento: `QueryPlannerService`

O `QueryPlannerService` decompõe perguntas mais complexas em passos.

Por exemplo, uma pergunta como:

```text
"Compare as queixas recentes do paciente com as medicações informadas na anamnese."
```

pode exigir mais de uma busca:

```text
1. buscar queixas recentes;
2. buscar medicações;
3. combinar as evidências na resposta.
```

Na defesa, eu diria que o planejamento é o que diferencia um RAG simples de um fluxo agentic. O sistema deixa de tratar toda pergunta como uma busca única e passa a representar a tarefa como um pequeno plano executável.

Mesmo quando há apenas um passo, a existência do planner é útil porque padroniza a execução. O orquestrador sempre trabalha sobre uma estrutura de plano.

## Reescrita de consulta: `QueryRewriterService`

O `QueryRewriterService` transforma a pergunta original em uma ou mais consultas mais adequadas para recuperação.

Isso é necessário porque a pergunta do usuário pode ter:

- linguagem informal;
- termos incompletos;
- referências implícitas;
- mistura de intenção clínica e contexto conversacional.

Uma pergunta como:

```text
"Ele tem alguma alergia importante?"
```

pode ser reescrita como:

```text
"alergias medicamentosas do paciente"
"reações adversas informadas na anamnese"
"restrições clínicas registradas"
```

Na defesa, eu destacaria que a reescrita melhora o recall da recuperação. O usuário pergunta em linguagem natural; o mecanismo de busca precisa de consultas mais explícitas.

## Recuperação: `RetrieverTool`

O `RetrieverTool` é responsável por recuperar evidências para o agente.

Ele conversa com o `RagService`, que por sua vez chama o serviço Fastify em `rag-pipeline`, especialmente o endpoint:

```text
POST /v1/retrieve
```

Esse endpoint retorna chunks com:

```text
chunkId
document
source
index
distance
score
metadata
```

Um detalhe importante é que o `RetrieverTool` não depende apenas do vetor store. Ele também pode incluir ou usar como fallback o `PostgresRetrieverService`. Isso é relevante porque nem toda informação clínica nasce em documentos textuais. Algumas informações estão estruturadas em tabelas: anamneses, documentos, status de ingestão e possivelmente agendamentos.

Na defesa, eu explicaria que esse desenho aproxima o sistema de um RAG híbrido: ChromaDB atende à busca semântica em documentos e snapshots; Postgres preserva acesso a dados estruturados e autoritativos.

## Recuperação em Postgres: `PostgresRetrieverService`

O `PostgresRetrieverService` transforma registros relacionais em chunks pesquisáveis pelo agente.

Esse componente é importante porque o banco relacional não é apenas infraestrutura; ele é a fonte de verdade do domínio. Se o sistema dependesse exclusivamente do ChromaDB, informações estruturadas poderiam ficar desatualizadas, incompletas ou difíceis de comparar.

Na defesa, eu diria que o Postgres retriever funciona como uma ponte entre RAG e dados transacionais. Ele permite que o agente use dados clínicos estruturados sem entregar ao LLM acesso livre ao banco.

Esse ponto é essencial: o agente não executa SQL arbitrário gerado pelo modelo. O backend consulta dados por serviços controlados, com `clinicId` e `patientId` já resolvidos.

## Avaliação do contexto: `ContextEvaluatorService`

Depois da recuperação, o sistema precisa decidir se os chunks encontrados são suficientes.

O `ContextEvaluatorService` retorna uma estrutura parecida com:

```text
{
  sufficient: boolean,
  score: number,
  missing: string[],
  suggestedQuery?: string,
  method: "cosine" | "llm" | "hybrid"
}
```

Esse componente é central para o loop corretivo, também conhecido como CRAG, ou Corrective RAG.

Se o contexto for insuficiente, o orquestrador pode tentar novamente com uma consulta sugerida. Isso resolve uma limitação clássica do RAG linear: a recuperação única. No RAG tradicional, se a primeira busca vier ruim, a resposta provavelmente será ruim. No fluxo agentic, o sistema tem uma chance controlada de corrigir a busca antes de responder.

Na defesa, eu apresentaria esse componente como uma barreira de qualidade antes da geração.

## Geração de resposta: `AnswerGeneratorService`

O `AnswerGeneratorService` é responsável por gerar a resposta final quando há contexto suficiente.

Ele pode usar o model gateway do backend ou, quando necessário, delegar a geração ao serviço RAG por meio de:

```text
POST /v1/generate
```

A resposta é enviada por streaming. Isso melhora a experiência do usuário, porque o texto começa a aparecer antes da conclusão total da geração.

Na defesa, eu enfatizaria que a geração só ocorre depois da recuperação e da avaliação do contexto. Isso reduz a chance de o modelo responder apenas com conhecimento paramétrico. O objetivo é que a resposta seja fundamentada nos registros do paciente.

## Verificação: `AnswerVerifierService`

Após a geração, o `AnswerVerifierService` verifica se a resposta está fundamentada nas evidências.

Ele produz um `VerificationResult`:

```text
{
  faithful: boolean,
  groundedness: number,
  citationsOk: boolean,
  unsupportedClaims: string[],
  action: "pass" | "regenerate" | "downgrade",
  method: "cosine" | "llm" | "hybrid"
}
```

O ponto mais importante é a ação `downgrade`. Se a resposta não estiver suficientemente apoiada nos chunks recuperados, o sistema pode substituir a resposta por uma mensagem de evidência insuficiente.

Na defesa, eu diria que o verifier é o mecanismo que protege o sistema contra a falsa confiança. Um texto fluente não é necessariamente um texto correto. O verifier força a arquitetura a perguntar: "essa resposta tem suporte nos registros recuperados?"

## Métricas RAG-Triad

O sistema também calcula métricas de avaliação:

```text
contextRelevance
groundedness
answerRelevance
perChunk
```

Essas métricas são calculadas pelo serviço RAG em:

```text
POST /v1/evaluate
```

e persistidas na mensagem do chat.

Na defesa, eu explicaria que essas métricas não substituem avaliação clínica humana, mas são úteis para estudo técnico. Elas permitem comparar execuções, identificar baixa relevância de contexto e estudar o comportamento do pipeline.

## Ferramentas: `ToolRegistryService`

O `ToolRegistryService` expõe ações do sistema como ferramentas tipadas e permissionadas.

Atualmente, as ferramentas principais são ações de agendamento:

```text
appointment.list_upcoming
appointment.create
appointment.reschedule
appointment.cancel
appointment.approve
appointment.reject
```

Cada ferramenta possui:

```text
name
kind
description
requiredPermission
mutating
confirmationRequired
defaultMode
inputSchema
examples
```

Na defesa, eu destacaria que isso evita que o LLM tenha acesso livre aos serviços internos. O modelo não chama funções arbitrárias; ele escolhe entre ferramentas registradas, com schema de entrada, permissão e modo de execução.

## Seleção de ferramentas: `ToolSelectorService`

O `ToolSelectorService` interpreta pedidos em linguagem natural que representam ações.

Exemplo:

```text
"Marque uma limpeza para amanhã às 14h com a Dra. Ana."
```

Esse pedido precisa virar uma estrutura como:

```text
{
  kind: "create",
  mode: "preview",
  args: {
    dentistName: "Dra. Ana",
    startsAt: "...",
    durationMinutes: 60,
    reason: "limpeza"
  }
}
```

Na defesa, eu explicaria que a seleção de ferramenta é separada da execução da ferramenta. Isso é uma decisão de segurança. Mesmo que o modelo selecione uma ação, a execução passa por validação, permissão e, se for mutável, confirmação humana.

## Resolução de dentistas: `DentistResolverService`

O `DentistResolverService` ajuda a transformar nomes informados pelo usuário em dentistas reais da clínica.

Isso é necessário porque usuários dificilmente informam UUIDs em linguagem natural. Eles dizem:

```text
"com a Dra. Ana"
```

e não:

```text
"dentistId=22222222-2222-4222-8222-222222222222"
```

Na defesa, eu usaria esse componente para mostrar como o projeto conecta linguagem natural a entidades reais do domínio, sem permitir que o modelo invente identificadores.

## Execução de ações: `ChatActionsService`

As ferramentas de agendamento reaproveitam o `ChatActionsService`, que já implementa a lógica transacional de ações no chat.

Esse serviço executa:

- listagem de próximos agendamentos;
- criação;
- remarcação;
- cancelamento;
- aprovação;
- recusa.

Todas as ações são escopadas ao paciente da sessão. Isso significa que, mesmo que um usuário tente agir sobre um agendamento de outro paciente, o backend rejeita.

Na defesa, eu destacaria que a arquitetura reaproveita regras de domínio já existentes. O agente não duplica a lógica de agendamento; ele apenas usa uma ferramenta controlada que chama o serviço correto.

## Preview e commit

Para ações mutáveis, o fluxo é:

```text
preview -> confirmação humana -> commit
```

O preview mostra ao usuário o que será feito. O commit só ocorre depois de confirmação explícita.

Essa decisão é crucial em um sistema com agente. Ela impede que uma inferência errada do modelo altere dados reais imediatamente.

Na defesa, eu diria que esse padrão funciona como uma barreira ética e operacional. O agente pode propor; o usuário autoriza.

## Guardrails: `SanitizerService`, `PermissionService` e `AgentRateLimitGuard`

O sistema possui guardrails em várias camadas.

O `SanitizerService` limpa a pergunta e os chunks antes de uso pelo modelo. Isso reduz risco de prompt injection e de conteúdo indesejado atravessar a cadeia de prompts.

O `PermissionService` verifica se o contexto do agente possui a permissão exigida pela ferramenta.

O `AgentRateLimitGuard` limita o volume de chamadas ao endpoint agentic.

Na defesa, eu explicaria que guardrails não são uma única função mágica. Eles são uma composição de restrições: autenticação, escopo de clínica, escopo de paciente, permissões de ferramenta, validação de DTO, orçamento de execução, rate limiting e fallback conservador.

## Memória: `MemoryService`

O `MemoryService` mantém um resumo da sessão de chat para uso futuro.

Esse componente evita que o sistema dependa apenas da última pergunta isolada. Ao mesmo tempo, ele não substitui a recuperação de evidências. A memória ajuda a contextualizar a conversa; as respostas clínicas ainda precisam ser fundamentadas nos registros recuperados.

Na defesa, eu ressaltaria essa distinção:

```text
memória conversa sobre o diálogo;
RAG fundamenta sobre os registros.
```

Essa separação é importante para evitar que a memória conversacional vire fonte clínica não verificada.

## Observabilidade: `AgentTracingService`

O `AgentTracingService` é um dos componentes mais importantes para o caráter acadêmico do projeto.

Ele registra:

```text
agent_runs
agent_steps
retrieved_chunks
agent_evaluations
tool_calls
prompt_versions
```

Cada execução do agente gera um `agent_run`. Cada etapa relevante vira um `agent_step`. Os chunks recuperados são registrados com score e distância. Avaliações de contexto e verificações de resposta são armazenadas. Chamadas de ferramenta também ficam registradas.

Na defesa, eu diria que esse componente transforma o agente em um objeto observável. Em vez de dizer apenas "a IA respondeu", o sistema permite perguntar:

- qual intenção foi classificada?
- quais consultas foram geradas?
- quais chunks foram recuperados?
- qual foi o score das evidências?
- o contexto foi considerado suficiente?
- houve fallback?
- houve chamada de ferramenta?
- qual foi a latência?
- qual modelo foi usado?
- quantos tokens foram registrados?

Isso é essencial para pesquisa, auditoria e melhoria contínua.

## Registro RAG na interface

Além de persistir no banco, o projeto expõe o histórico na interface do assistente.

A tela do assistente contém um registro de execuções RAG, carregado por:

```text
GET /v1/agent/runs
GET /v1/agent/runs/:runId
```

Esse registro permite expandir uma execução e visualizar:

- pergunta;
- intenção;
- status;
- duração;
- etapas ordenadas;
- entrada e saída bruta de cada etapa;
- chunks recuperados;
- scores e distâncias;
- erros e fallbacks.

Na defesa, eu apresentaria esse ponto como uma contribuição pedagógica do projeto. O sistema não é apenas uma aplicação que usa RAG; ele permite estudar como o RAG foi executado.

## Prompt Registry

O registro de prompts mantém versões e hashes dos prompts usados pelos módulos agentic.

Isso é importante porque, em sistemas com LLM, alterações pequenas no prompt podem mudar o comportamento. Ao versionar prompts, o projeto cria base para reprodutibilidade.

Na defesa, eu diria que prompt versioning é parte da engenharia do agente. Não basta salvar código; é preciso controlar também as instruções que orientam o modelo.

## Model Gateway

O `ModelsModule` e o gateway de modelos concentram o acesso ao Ollama para tarefas do agente.

Essa separação permite trocar modelos por tarefa:

```text
AGENT_LLM_MODEL
AGENT_PLAN_MODEL
AGENT_REWRITE_MODEL
```

Na defesa, eu explicaria que isso evita acoplamento direto entre cada componente e o runtime do LLM. O roteador, o planner ou o generator não precisam conhecer detalhes de infraestrutura; eles dependem de uma abstração de modelo.

## Relação com o serviço RAG

O serviço RAG Fastify não foi descartado. Ele foi dividido em primitivas:

```text
/v1/embed
/v1/retrieve
/v1/generate
/v1/evaluate
```

e mantém o endpoint legado:

```text
/v1/chat
```

Na defesa, eu diria que essa decisão permitiu uma migração incremental. O sistema antigo, linear, continua possível. O sistema novo, agentic, usa os blocos menores para controlar cada etapa.

Essa é uma decisão de engenharia importante: em vez de reescrever tudo, o projeto encapsula o RAG existente e move a inteligência de orquestração para o backend.

## Como eu explicaria o fluxo completo para a banca

Se a banca perguntar "o que acontece quando o usuário faz uma pergunta ao assistente?", eu responderia assim:

Primeiro, o frontend envia a pergunta para o endpoint agentic da API, usando JWT e o identificador da clínica ativa. A API valida a sessão de chat e descobre o paciente vinculado a essa sessão. Com isso, o escopo do agente já nasce fechado: ele não pode pesquisar outro paciente.

Depois, o orquestrador sanitiza a pergunta, persiste a mensagem do usuário e abre um `agent_run`. Em seguida, o roteador classifica a intenção. Se for uma pergunta clínica, o planner define os passos, o rewriter gera consultas e o retriever busca evidências em ChromaDB e, quando aplicável, em Postgres.

Com as evidências recuperadas, o evaluator decide se o contexto é suficiente. Se não for, o sistema pode tentar uma nova busca dentro do orçamento definido. Se o contexto for suficiente, a resposta é gerada em streaming.

Depois da geração, o sistema calcula métricas RAG-Triad e executa a verificação de fundamentação. Se a resposta não estiver bem suportada, ela é substituída por uma mensagem de evidência insuficiente. Por fim, a resposta é persistida no histórico do chat, o `agent_run` é finalizado e a interface pode carregar o trace completo.

Essa explicação mostra que o agente não é uma caixa-preta. Ele é um pipeline controlado, observável e limitado por regras.

## Como eu defenderia a escolha por Agentic RAG

Eu defenderia que o Agentic RAG foi escolhido porque o domínio exige mais do que busca semântica.

Uma clínica precisa:

- consultar documentos;
- consultar dados estruturados;
- respeitar escopo de paciente;
- executar ações operacionais;
- confirmar mutações;
- explicar de onde veio a resposta;
- saber quando não há evidência suficiente.

Um RAG linear responde parte disso, mas não tudo. O Agentic RAG permite representar o problema como uma sequência de decisões controladas. A principal vantagem, portanto, não é apenas "melhor resposta", mas melhor governança da resposta.

## Pontos fortes para enfatizar na defesa

Eu enfatizaria cinco pontos fortes.

Primeiro, isolamento por paciente. O paciente é definido pela sessão e validado pelo backend, não pelo modelo.

Segundo, arquitetura modular. Cada responsabilidade do agente está em um serviço separado, facilitando testes e evolução.

Terceiro, recuperação híbrida. O sistema usa ChromaDB para busca semântica e Postgres para dados estruturados/fallback.

Quarto, ações seguras. Ferramentas mutáveis usam preview e commit com confirmação humana.

Quinto, observabilidade. O registro RAG permite estudar a execução passo a passo, o que é especialmente valioso para um projeto acadêmico.

## Limitações que eu assumiria na defesa

Eu também assumiria limitações de forma transparente.

Primeiro, o projeto não é um sistema de diagnóstico médico automatizado. Ele é um assistente de consulta e organização de evidências.

Segundo, a qualidade das respostas depende da qualidade dos documentos, da anamnese e da ingestão.

Terceiro, traces podem carregar dados sensíveis. Em produção, seria necessário reforçar políticas de redação, retenção e acesso.

Quarto, a idempotência de ferramentas ainda pode evoluir para armazenamento persistente, em vez de controle em memória.

Quinto, a avaliação automática por similaridade é útil, mas não substitui validação clínica humana.

Assumir essas limitações fortalece a defesa, porque mostra maturidade técnica e consciência ética.

## Perguntas prováveis da banca e respostas sugeridas

### Por que não usar apenas RAG simples?

Porque o RAG simples recupera e responde em um fluxo linear. O projeto precisa também classificar intenção, executar ferramentas, validar contexto, aplicar fallback e registrar o processo. O Agentic RAG oferece controle e observabilidade.

### O LLM pode acessar dados de outro paciente?

Não. O escopo do paciente é definido antes da chamada ao agente, pela sessão de chat validada no backend. A recuperação recebe `patientId` já resolvido e as queries relacionais usam `clinicId` e `patientId`.

### O agente pode alterar dados sozinho?

Não. Ferramentas mutáveis exigem preview e confirmação humana antes do commit. Além disso, as ferramentas são tipadas, permissionadas e validadas.

### Como vocês sabem se a resposta está fundamentada?

O sistema usa métricas RAG-Triad e um verificador de resposta. Ele registra groundedness, citações e claims sem suporte. Se a verificação falhar, a resposta pode ser rebaixada para evidência insuficiente.

### Qual a contribuição acadêmica do registro RAG?

O registro permite estudar empiricamente a execução do agente. Ele mostra as etapas, os dados de entrada e saída, os chunks recuperados, scores, latência, ferramentas e fallbacks. Isso transforma o comportamento do agente em objeto de análise.

### Por que o orquestrador fica no NestJS e não no serviço RAG?

Porque o orquestrador precisa de identidade, permissões, sessão, paciente, ferramentas de domínio, persistência e traces. Essas responsabilidades pertencem ao backend principal, que é a fronteira de confiança. O serviço RAG fica como provedor de primitivas.

## Fechamento da fala

Para concluir a apresentação dos componentes do agente, eu resumiria assim:

O módulo agentic do Intelli-Dental foi construído para transformar uma pergunta em uma execução controlada. A arquitetura combina linguagem natural com regras explícitas de backend. O LLM participa onde ele é útil: interpretação, reescrita, planejamento e geração. Mas decisões sensíveis, como escopo de dados, permissões, mutações e persistência, permanecem sob controle do sistema.

Assim, o projeto não defende apenas o uso de IA em um CRM odontológico. Ele defende uma forma responsável de integrar IA: com escopo, evidência, confirmação humana e rastreabilidade.

