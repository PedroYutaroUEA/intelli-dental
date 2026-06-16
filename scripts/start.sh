#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# Intelli Dental bootstrap
#
# - Copies *.env.example -> *.env on first run.
# - Reads model names from api/.env and rag-pipeline/.env; pulls all of them.
# - Ensures host Ollama is running and reachable from containers (0.0.0.0).
# - Builds and starts the stack with docker compose.
# - Waits for services to become healthy.
#
# Re-running the script is safe: every step is idempotent.
# ----------------------------------------------------------------------------

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OLLAMA_PORT="${OLLAMA_PORT:-11434}"
OLLAMA_LOG="${TMPDIR:-/tmp}/intelli-dental-ollama.log"

# Read a key=value pair from an env file (strips surrounding quotes and spaces)
parse_env_value() {
  local file="$1" key="$2"
  grep -E "^[[:space:]]*${key}[[:space:]]*=" "${file}" 2>/dev/null \
    | tail -n1 | cut -d= -f2- | sed "s/^[[:space:]]*//;s/[[:space:]]*$//;s/^['\"]//;s/['\"]$//"
}

# Accumulate unique non-empty model names into models_to_pull[]
declare -A _seen_models=()
models_to_pull=()
add_model() {
  local m="$1"
  [[ -z "${m}" ]] && return
  [[ -n "${_seen_models[${m}]+x}" ]] && return
  _seen_models["${m}"]=1
  models_to_pull+=("${m}")
}

c_red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }
step()     { c_blue "==> $*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || { c_red "Missing required command: $1"; exit 1; }
}

# ----------------------------------------------------------------------------
# 1. Tooling check
# ----------------------------------------------------------------------------
step "Checking required tooling"
require docker
docker compose version >/dev/null 2>&1 || { c_red "docker compose plugin not found"; exit 1; }
require ollama
require curl

# ----------------------------------------------------------------------------
# 2. Seed .env files on first run (must happen before reading model names)
# ----------------------------------------------------------------------------
step "Seeding .env files (only if missing)"
for path in api rag-pipeline; do
  if [[ -f "${path}/.env.example" && ! -f "${path}/.env" ]]; then
    cp "${path}/.env.example" "${path}/.env"
    c_green "  + created ${path}/.env"
  fi
done

# ----------------------------------------------------------------------------
# 3. Collect models from .env files
# ----------------------------------------------------------------------------
step "Reading model configuration from .env files"

for key in LLM_MODEL AGENT_LLM_MODEL AGENT_PLAN_MODEL AGENT_REWRITE_MODEL; do
  val="$(parse_env_value api/.env "${key}")"
  if [[ -n "${val}" ]]; then
    c_green "  api/.env          ${key}=${val}"
    add_model "${val}"
  fi
done

for key in LLM_MODEL EMBED_MODEL; do
  val="$(parse_env_value rag-pipeline/.env "${key}")"
  if [[ -n "${val}" ]]; then
    c_green "  rag-pipeline/.env ${key}=${val}"
    add_model "${val}"
  fi
done

if [[ ${#models_to_pull[@]} -eq 0 ]]; then
  c_yellow "No models found in .env files; falling back to defaults."
  models_to_pull=("qwen2.5:3b" "nomic-embed-text")
fi
c_blue "  Models to pull: ${models_to_pull[*]}"

# ----------------------------------------------------------------------------
# 4. Ollama: ensure it listens on 0.0.0.0 so containers can reach it
# ----------------------------------------------------------------------------
step "Ensuring Ollama is reachable on 0.0.0.0:${OLLAMA_PORT}"

bound_address=""
if command -v ss >/dev/null 2>&1; then
  bound_address="$(ss -tlnH "sport = :${OLLAMA_PORT}" 2>/dev/null | awk '{print $4}' | head -n1 || true)"
fi

needs_restart=false
if [[ -z "${bound_address}" ]]; then
  needs_restart=true
elif [[ "${bound_address}" == 127.0.0.1:* || "${bound_address}" == "[::1]:"* ]]; then
  c_yellow "Ollama is bound to ${bound_address} (loopback only); restarting on 0.0.0.0."
  needs_restart=true
else
  c_green "Ollama already listening on ${bound_address}."
fi

if [[ "${needs_restart}" == true ]]; then
  # Stop any existing instance (systemd or manual) without failing the script
  # if there's nothing to stop.
  if systemctl is-active --quiet ollama 2>/dev/null; then
    c_yellow "Stopping systemd ollama service (will be replaced by host process)."
    sudo systemctl stop ollama || true
  fi
  pkill -f "ollama serve" 2>/dev/null || true
  # Give the OS a moment to release the port.
  sleep 1
  step "Starting 'ollama serve' on 0.0.0.0:${OLLAMA_PORT} (logs: ${OLLAMA_LOG})"
  OLLAMA_HOST="0.0.0.0:${OLLAMA_PORT}" nohup ollama serve >"${OLLAMA_LOG}" 2>&1 &
  # Wait for the API to come up.
  for _ in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${OLLAMA_PORT}/api/tags" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! curl -sf "http://127.0.0.1:${OLLAMA_PORT}/api/tags" >/dev/null 2>&1; then
    c_red "Ollama did not become ready within 30s. See ${OLLAMA_LOG}."
    exit 1
  fi
  c_green "Ollama is up."
fi

# ----------------------------------------------------------------------------
# 5. Pull required models if missing
# ----------------------------------------------------------------------------
step "Ensuring Ollama models are present"
existing_models="$(curl -sf "http://127.0.0.1:${OLLAMA_PORT}/api/tags" | tr ',' '\n' | grep -oE '"name":"[^"]+"' | sed 's/.*:"//;s/"//' || true)"
for model in "${models_to_pull[@]}"; do
  if grep -Fxq "${model}" <<<"${existing_models}"; then
    c_green "  ✓ ${model}"
  else
    c_yellow "  ↓ pulling ${model} (this can take a while)"
    OLLAMA_HOST="127.0.0.1:${OLLAMA_PORT}" ollama pull "${model}"
  fi
done

# ----------------------------------------------------------------------------
# 6. Build & start the stack
# ----------------------------------------------------------------------------
step "Building images (cached layers reused when possible)"
docker compose build

step "Starting stack"
docker compose up -d

# ----------------------------------------------------------------------------
# 7. Wait for postgres + api to be ready
# ----------------------------------------------------------------------------
step "Waiting for Postgres to become healthy"
for _ in $(seq 1 60); do
  status="$(docker inspect --format='{{.State.Health.Status}}' intelli-dental-postgres-1 2>/dev/null || echo starting)"
  if [[ "${status}" == "healthy" ]]; then break; fi
  sleep 1
done
c_green "Postgres: ${status}"

step "Waiting for API on http://localhost:4000"
for _ in $(seq 1 60); do
  if curl -sf http://localhost:4000/v1/health >/dev/null 2>&1; then
    c_green "API is up."
    break
  fi
  sleep 2
done

step "Waiting for RAG on http://localhost:3000"
for _ in $(seq 1 60); do
  if curl -sf http://localhost:3000/v1/health >/dev/null 2>&1; then
    c_green "RAG is up."
    break
  fi
  sleep 2
done

# ----------------------------------------------------------------------------
# 8. Summary
# ----------------------------------------------------------------------------
cat <<EOF

$(c_green "Intelli Dental is up.")
  • App:     http://localhost:3567
  • API:     http://localhost:4000/v1/health
  • RAG:     http://localhost:3000/v1/health
  • Adminer: http://localhost:8080  (server: postgres, user: dental)
  • Ollama:  http://localhost:${OLLAMA_PORT}  (logs: ${OLLAMA_LOG})

Tail logs with:  docker compose logs -f api rag
Stop with:       docker compose down
EOF
