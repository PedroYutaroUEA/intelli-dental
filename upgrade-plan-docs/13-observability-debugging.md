# 13. Observability and debugging

Every agent execution writes one `agent_run` plus N `agent_steps` and M `tool_calls`. The fields below are the canonical trace record.

| Field | Source | Use |
|---|---|---|
| `agent_run_id` | orchestrator | correlate all steps + the persisted `chat_message`. |
| `user_id`, `tenant_id` (clinicId) | `AgentContext` | per-tenant analytics, abuse detection. |
| `patient_id` | `AgentContext` | scope verification, isolation audits. |
| `original_question` | request | reproduction, golden-set growth. |
| `detected_intent` | IntentRouter | routing accuracy analysis. |
| `rewritten_queries` | QueryRewriter | recall debugging. |
| `tools_called` | ToolRegistry | which tools, args (redacted), result, mutated?. |
| `retrieved_chunks` | RetrieverTool | chunk ids + scores (NOT raw text at info level). |
| `context_scores` | ContextEvaluator | sufficiency decisions, threshold tuning. |
| `model_used` | ModelGateway | per task; cost/perf by model. |
| `token_usage` | ModelGateway | tokensIn/Out per step + totals. |
| `latency` | per step + total | p50/p95 SLA tracking. |
| `final_answer` | generator | quality review (PII-aware storage). |
| `verification_result` | AnswerVerifier | faithfulness/citation auditing. |
| `errors` | any step | failure analysis. |
| `fallback_used` | orchestrator | how often heuristics/refusals kick in. |

## 13.1 How it powers debugging & improvement

- **Single trace view** (`/agent-runs/:id`) reconstructs the whole decision path → fast root-cause when an answer is wrong.
- **Routing audits:** compare `detected_intent` vs human label on sampled runs → retrain prompt/heuristics.
- **Threshold tuning:** plot `context_scores` vs final correctness → adjust evaluator/verifier cutoffs.
- **Regression guard:** failing golden-set runs are saved as fixtures.
- **Cost/latency dashboards:** group token usage and latency by `model_used` and `step.type`.
- **PII hygiene:** at `LOG_LEVEL=info`, store chunk **ids + scores**, not document text; raw text only at `debug` and never shipped to the client.

## 13.2 Minimal logging contract

```ts
this.tracing.step(runId, {
  type: 'retrieve',
  durationMs, output: { attempt, queries, chunkIds: chunks.map(c => c.chunkId), topScore },
});
```

---
