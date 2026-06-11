# 10. Integration with Ollama

All Ollama access goes through `ModelGateway` → `OllamaService`. No module calls Ollama directly. This centralizes routing, JSON mode, retries, timeouts, and token accounting, and makes model replacement a config change.

## 10.1 Per-task model routing

| Task | Default model | Temp | JSON | Notes |
|---|---|---|---|---|
| `embed` | `nomic-embed-text` | — | — | unchanged; cacheable. |
| `intent` | `phi3:mini` | 0 | yes | tiny output; cheap. |
| `rewrite` | `llama3.2:3b` | 0 | yes | could use `llama3.2:3b` for better paraphrase. |
| `plan` | `llama3.2:3b` (fallback `phi3:mini`) | 0 | yes | benefits from a slightly stronger model. |
| `evaluate` | `phi3:mini` | 0 | yes | only on borderline (cosine first). |
| `generate` | `phi3:mini` | 0.2 | no (streamed) | the user-facing answer; keep current model. |
| `verify` | `phi3:mini` | 0 | yes | NLI-style faithfulness, only on borderline. |
| `tool_select` | `phi3:mini` | 0 | yes | constrained to registered tool names. |

Routing is a map in config so each task can be swapped with `AGENT_<TASK>_MODEL`:

```env
AGENT_INTENT_MODEL=phi3:mini
AGENT_REWRITE_MODEL=phi3:mini
AGENT_PLAN_MODEL=phi3:mini
AGENT_EVALUATE_MODEL=phi3:mini
AGENT_GENERATE_MODEL=phi3:mini
AGENT_VERIFY_MODEL=phi3:mini
AGENT_TOOL_SELECT_MODEL=phi3:mini
```

Resolution order is:

```ts
modelOverride > AGENT_<TASK>_MODEL > AGENT_LLM_MODEL > LLM_MODEL > 'phi3:mini'
```

The "different model per task" strategy is **optional** — the MVP can use a single model for everything except embeddings.

### Quality upgrade

Required MVP models:

- `phi3:mini`
- `nomic-embed-text`

Optional quality model:

- `llama3.2:3b`

Use `llama3.2:3b` first for `plan`, and optionally for `rewrite` if the host has enough RAM/VRAM and the added latency is acceptable:

```env
AGENT_PLAN_MODEL=llama3.2:3b
AGENT_REWRITE_MODEL=llama3.2:3b
```

Bootstrap keeps `llama3.2:3b` opt-in:

```bash
AGENT_QUALITY_UPGRADE=true ./scripts/start.sh
```

## 10.2 JSON / structured output

For all control tasks (`intent`, `rewrite`, `plan`, `evaluate`, `verify`, `tool_select`) call Ollama `/api/chat` with `format: "json"` and `stream: false`, then **zod-parse** the result. Example gateway call:

```ts
async complete(req: ModelRequest): Promise<ModelResponse> {
  const model = req.modelOverride ?? this.routeModel(req.task);
  const started = Date.now();
  const body = {
    model,
    messages: req.messages,
    stream: false,
    format: req.json ? 'json' : undefined,
    options: {
      temperature: req.temperature ?? this.defaultTemp(req.task),
      num_predict: req.maxTokens ?? this.defaultMaxTokens(req.task),
    },
  };
  const res = await this.ollama.chat(body, req.timeoutMs ?? this.defaultTimeout(req.task));
  let parsed: unknown;
  if (req.json) parsed = this.parseJsonOrRetry(res.text, req); // retry once with "return ONLY JSON" nudge
  return { text: res.text, parsedJson: parsed, model, tokensIn: res.promptEvalCount,
           tokensOut: res.evalCount, latencyMs: Date.now() - started, fallbackModelUsed: false };
}
```

## 10.3 Retry on invalid responses

- **JSON parse failure:** retry once with a stricter instruction appended (`"Responda APENAS com JSON válido, sem texto extra."`). If it still fails → use the module's deterministic fallback (no-op rewrite, cosine-only evaluation, etc.). Never throw raw parse errors to the user.
- **Schema validation failure (zod):** treated like a parse failure.

## 10.4 Latency & temperature control

- Control tasks: `temperature 0`, small `num_predict` (e.g. 128–256) to bound latency.
- Generation: `temperature 0.2` for natural but grounded prose; cap `num_predict` (e.g. 512).
- Set per-task `timeoutMs`; on timeout use fallback. Abort the Ollama stream when the SSE client disconnects (pass an `AbortSignal` into `fetch`).
- Use Ollama `keep_alive` to keep hot models resident; warm up `phi3:mini` on boot with a 1-token request.

## 10.5 Fallback model tier

```
generate:  phi3:mini  →(timeout/error)→  llama3.2:3b? (only if resident)  →  safe error message
plan:      llama3.2:3b →(unavailable)→   phi3:mini
control:   phi3:mini  →(fail)→           deterministic heuristic (no model)
```
Fallback is **downward to a guaranteed-resident model or a non-LLM heuristic**, never to an external API (the system is fully local).

## 10.6 Local model routing strategy (summary)

1. Embeddings: always `nomic-embed-text` (separate model, cache results).
2. One small generalist (`phi3:mini`) handles all control + generation in the MVP.
3. Promote specific tasks (`plan`, optionally `rewrite`) to `llama3.2:3b` only after measuring quality gains worth the latency on CPU.
4. Keep a single model resident under memory pressure; only run a second model if the host has the RAM/VRAM.

---
