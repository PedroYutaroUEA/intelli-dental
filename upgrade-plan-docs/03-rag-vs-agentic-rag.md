# 3. Difference between current RAG and Agentic RAG

| Pattern | Control flow | Retries | Tools | Where it fits Dental-CRM |
|---|---|---|---|---|
| **Traditional RAG** (today) | Fixed: `retrieve → stuff → generate`. No decisions. | None | None | Current `/v1/chat`. Cheap, predictable, but blind to retrieval quality. |
| **Adaptive RAG** | A router decides *whether/how* to retrieve (skip retrieval for chit-chat, choose k/strategy) before a single generation. | None (one pass) | Optional | Adds `IntentRouter` + `QueryRewriter`. Avoids wasting Ollama calls on "olá". |
| **Corrective RAG (CRAG)** | After retrieval, an evaluator grades context; if weak, it triggers a corrective action (re-query / broaden / fallback) before generating. | Bounded re-retrieval | Optional | Adds `ContextEvaluator` + iterative loop. Directly fixes "I don't know" failures. |
| **Agentic RAG** | An orchestrator runs a loop: plan → act (call tools incl. retrieval) → observe → decide → verify. | Bounded, cost-capped | Yes (typed) | The target. Wraps RAG as one tool among `PatientRecordTool`, `AppointmentTool`. |
| **Multi-agent RAG** | Multiple specialized agents (planner, researcher, critic) coordinate, possibly in parallel, with a supervisor. | Bounded per agent | Yes | Overkill now. Keep planner/critic as *modules*, not separate agents, so we can split later. |

### Practical differences in this codebase

- **Traditional → Adaptive:** today every message embeds + queries Chroma + calls phi3. With a router, "qual o telefone do paciente?" goes to `PatientRecordTool` (a SQL read), **not** the LLM — faster, exact, no hallucination surface.
- **Adaptive → Corrective:** today a weak retrieval still produces an answer (or the canned "I don't know"). With CRAG, a low context-relevance score (we already compute it) triggers a rewrite-and-retry before giving up.
- **Corrective → Agentic:** the existing slash-commands prove tools work. Agentic RAG lets the model *choose* `/listar` vs RAG vs SQL based on intent, behind the same `preview → commit` safety gate.

### Recommended approach for the **initial** migration

Adopt **Adaptive + Corrective RAG inside a single, deterministic orchestrator** — i.e. *Agentic RAG with a state machine, not an LLM free-for-all*.

Reasons:
1. **Determinism & cost.** A hand-written state machine (router → rewrite → retrieve → evaluate → generate → verify) is debuggable, testable, and bounded. phi3:mini is not strong enough to be trusted as an autonomous planner emitting arbitrary tool-call loops.
2. **Reuse.** It maps 1:1 onto modules we already need (router, evaluator, verifier) and onto existing assets (metrics, actions, isolation).
3. **Safety.** Every tool call passes through the existing trust boundary + the new permission layer; no open-ended autonomy that could leak data or trigger mutations.

Multi-agent and LLM-driven planning are **explicitly deferred** (see §18) until the deterministic pipeline is instrumented and proven.

---
