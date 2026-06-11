# 14. Success metrics

Measured on the golden set (offline) and sampled production traces (online).

| Metric | Definition | How to measure |
|---|---|---|
| **Answer accuracy** | Answer matches the expected answer. | Human/LLM-judge label on golden set; exact/semantic match. |
| **Faithfulness** | Claims supported by retrieved context. | `AnswerVerifier.groundedness` + per-sentence cosine; sample human review. |
| **Context precision** | Fraction of retrieved chunks that are relevant. | Label retrieved chunks vs question; precision@k on golden set. |
| **Context recall** | Fraction of needed evidence that was retrieved. | Compare retrieved chunk ids vs annotated gold chunk ids. |
| **Citation accuracy** | Citations point to chunks that actually support the claim. | Validate each `[source:#idx]` against the cited chunk; % correct. |
| **Hallucination rate** | Answers with ≥1 unsupported factual claim. | `unsupportedClaims.length > 0` post-verify + human spot-check. |
| **Latency** | End-to-end wall-clock. | `agent_run.totalLatencyMs` p50/p95/p99. |
| **Cost per request** | Compute proxy (tokens + LLM calls). | sum `tokensIn+tokensOut`, count LLM calls per run (local ⇒ cost = latency/compute). |
| **Tool error rate** | Failed tool executions / total tool calls. | `tool_calls.ok=false` ratio. |
| **Retry rate** | Runs that triggered ≥1 CRAG retry. | count runs with retrieve `attempt>0`. |
| **User satisfaction** | Thumbs up/down per answer. | feedback table (§16) joined to `agent_run_id`. |
| **% unanswered (insufficient evidence)** | Correct refusals / total. | `insufficientEvidence=true`; ensure they are *correct* refusals, not laziness. |

Baseline these in Phase 1; gate each phase on "no regression" against the prior phase.

---
