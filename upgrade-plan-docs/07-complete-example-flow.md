# 7. Complete example flow

**Question (clinical analogue of the requested example):**
> "Quais documentos indicam que o paciente teve problemas recorrentes de gengiva, e qual foi a recomendação final?"
> *("Which documents indicate the patient had recurring gum problems, and what was the final recommendation?")*

This is a **two-part, multi-step** question: (a) find documents evidencing recurrence, (b) find the final recommendation.

### 1. User input
```json
POST /chat/sessions/sess_42/agent
Authorization: Bearer <jwt>
Accept: text/event-stream
{ "question": "Quais documentos indicam que o paciente teve problemas recorrentes de gengiva, e qual foi a recomendação final?" }
```
Guards resolve `context = { agentRunId:"run_88", patientId:"pat_7", clinicId:"cli_1", userId:"u_9", permissions:["rag:read","patient:read"] }`.

### 2. IntentRouter classification
```json
{ "intent":"multi_step_question", "confidence":0.86, "needsRetrieval":true, "needsTool":false,
  "reason":"two sub-questions: evidence of recurrence + final recommendation" }
```
→ SSE: `event: step` `{ "step":"intent", "data":{ "intent":"multi_step_question" } }`

### 3. Plan from QueryPlanner
```json
{ "strategy":"sequential", "steps":[
  { "id":"s1", "question":"Documentos que indicam problemas recorrentes de gengiva (gengivite/periodontite recorrente)" },
  { "id":"s2", "question":"Recomendação final registrada para o quadro gengival", "dependsOn":["s1"] }
]}
```

### 4. Queries from QueryRewriter (per step)
- s1 → `{ "queries":[
    "problemas recorrentes de gengiva",
    "gengivite recorrente periodontite histórico",
    "sangramento gengival repetido reincidência" ] }`
- s2 → `{ "queries":[
    "recomendação final tratamento gengival",
    "plano de tratamento conclusão periodontia" ] }`

### 5. RetrieverTool calls
`retrieveMany(s1.queries, ctx)` and later `retrieveMany(s2.queries, ctx)` — each query embedded via `nomic-embed-text`, queried in ChromaDB with **filter `{ patientId:"pat_7" }`**, results merged + deduped by `chunkId`.

### 6. Retrieved results (excerpt, normalized scores)
```json
[
  { "chunkId":"anamnesis.txt#3","source":"anamnesis.txt","index":3,"score":0.81,
    "document":"Queixa de sangramento gengival recorrente há 8 meses..." },
  { "chunkId":"consulta-2025-03.pdf#2","source":"consulta-2025-03.pdf","index":2,"score":0.78,
    "document":"Retorno: persiste inflamação gengival, segunda recidiva no quadrante inferior..." },
  { "chunkId":"plano-tratamento.json#0","source":"plano-tratamento.json","index":0,"score":0.74,
    "document":"Recomendação: raspagem e alisamento radicular + reavaliação em 90 dias..." }
]
```

### 7. ContextEvaluator output
- s1: `{ "sufficient":true, "score":0.80, "missing":[], "method":"cosine" }`
- s2: first pass borderline → cheap gate `0.55` → LLM gate runs:
```json
{ "sufficient":false, "score":0.55, "missing":["recomendação final explícita; só há plano inicial"],
  "suggestedQuery":"recomendação final pós-raspagem manutenção periodontal", "method":"llm" }
```

### 8. Additional search (CRAG loop, attempt 2 for s2)
`rewrite("recomendação final pós-raspagem manutenção periodontal")` → retrieve again:
```json
[ { "chunkId":"consulta-2025-06.pdf#1","source":"consulta-2025-06.pdf","index":1,"score":0.83,
    "document":"Conclusão: alta da fase ativa; manutenção periodontal trimestral e higiene supervisionada." } ]
```
Re-evaluate s2: `{ "sufficient":true, "score":0.82, "missing":[] }` → loop stops (attempt 2 ≤ MAX 2).

### 9. Answer generation (streamed)
Generator receives deduped evidence from s1+s2 and the grounding system prompt; streams tokens:
```
Os registros indicam problemas gengivais recorrentes em dois documentos: a anamnese
[source:anamnesis.txt#3] (sangramento recorrente há 8 meses) e o retorno
[source:consulta-2025-03.pdf#2] (segunda recidiva). A recomendação final foi alta da
fase ativa com manutenção periodontal trimestral e higiene supervisionada
[source:consulta-2025-06.pdf#1].
```

### 10. Answer verification
```json
{ "faithful":true, "groundedness":0.88, "citationsOk":true, "unsupportedClaims":[],
  "action":"pass", "method":"hybrid" }
```

### 11. Final user answer
The streamed answer above is returned, with citation chips: `anamnesis.txt#3`, `consulta-2025-03.pdf#2`, `consulta-2025-06.pdf#1`. SSE closes with `event: done { "agentRunId":"run_88" }`.

### 12. Full agent trace (persisted)
```json
{
  "id":"run_88","question":"Quais documentos...","intent":"multi_step_question",
  "totalTokensIn":1320,"totalTokensOut":210,"totalLatencyMs":9120,"fallbackUsed":false,
  "steps":[
    {"type":"intent","model":"phi3:mini","durationMs":410,"output":{"intent":"multi_step_question","confidence":0.86}},
    {"type":"plan","model":"phi3:mini","durationMs":520,"output":{"steps":2}},
    {"type":"rewrite","model":"phi3:mini","durationMs":300,"output":{"step":"s1","queries":3}},
    {"type":"retrieve","durationMs":640,"output":{"step":"s1","chunks":6,"topScore":0.81}},
    {"type":"evaluate","durationMs":120,"output":{"step":"s1","sufficient":true,"score":0.80}},
    {"type":"rewrite","model":"phi3:mini","durationMs":280,"output":{"step":"s2","queries":2}},
    {"type":"retrieve","durationMs":600,"output":{"step":"s2","attempt":0,"chunks":5,"topScore":0.74}},
    {"type":"evaluate","model":"phi3:mini","durationMs":700,"output":{"step":"s2","attempt":0,"sufficient":false,"suggestedQuery":"..."}},
    {"type":"retrieve","durationMs":580,"output":{"step":"s2","attempt":1,"chunks":3,"topScore":0.83}},
    {"type":"evaluate","durationMs":110,"output":{"step":"s2","attempt":1,"sufficient":true,"score":0.82}},
    {"type":"generate","model":"phi3:mini","durationMs":3900,"tokensOut":210},
    {"type":"verify","model":"phi3:mini","durationMs":1280,"output":{"faithful":true,"groundedness":0.88,"action":"pass"}}
  ]
}
```

---
