"use client"

import { Fragment, useEffect, useRef, useState } from "react"
import { AppSidebar } from "@/components/app-sidebar"
import { TopNav } from "@/components/top-nav"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Sparkles, Send, AlertCircle, Loader2, RefreshCw, ChevronDown, ChevronRight } from "lucide-react"
import {
  agentApi,
  chatApi,
  documentsApi,
  patientsApi,
  streamChat,
  type AgentRunRegistryItem,
  type AgentRunTrace,
  type ChatActionPayload,
  type ChatActionResult,
  type ChatMessage,
  type AgentPreviewEvent,
  type AgentStepEvent,
  type PatientDocument,
  type PatientSummary,
  type RagMetrics,
  type SourceRef,
} from "@/lib/api-client"
import { AuthGate } from "@/lib/auth-gate"
import { parseChatCommand } from "@/lib/chat-commands"
import { errorMessage } from "@/lib/errors"
import { formatScorePct, scoreColorClass } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface UiMessage {
  id: string
  role: "user" | "assistant"
  content: string
  sources?: SourceRef[]
  metrics?: {
    contextRelevance: number | null
    groundedness: number | null
    answerRelevance: number | null
  }
  /** When set, render an inline confirmation card with Confirmar/Cancelar. */
  pendingAction?: ChatActionPayload
  step?: string
  debug?: AgentDebugState
  agentRunId?: string
  agentTrace?: AgentRunTrace
  traceLoading?: boolean
  traceError?: string
}

interface AgentDebugState {
  intent?: string
  queries?: string[]
  context?: {
    sufficient?: boolean
    score?: number
    missing?: string[]
  }
  verified?: boolean
  steps?: AgentStepEvent[]
}

const STEP_LABELS: Record<string, string> = {
  intent: "Classificar intenção",
  plan: "Planejar execução",
  rewrite: "Reescrever consulta",
  retrieve: "Recuperar evidências",
  evaluate: "Avaliar contexto",
  tool: "Executar ferramenta",
  generate: "Gerar resposta",
  verify: "Verificar resposta",
  fallback: "Fallback",
  error: "Erro",
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function formatDateTime(value?: string | null): string {
  if (!value) return "Sem data"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Sem data"
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatDuration(ms?: number | null): string {
  if (typeof ms !== "number") return "n/a"
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function stepLabel(type: string): string {
  return STEP_LABELS[type] ?? type
}

function runStatus(run: AgentRunRegistryItem): {
  label: string
  variant: "default" | "secondary" | "destructive" | "outline"
} {
  if (run.run.error) return { label: "erro", variant: "destructive" }
  if (run.run.insufficientEvidence) return { label: "sem evidência", variant: "outline" }
  if (run.run.fallbackUsed) return { label: "fallback", variant: "secondary" }
  return { label: "ok", variant: "default" }
}

function summarizeStep(step: AgentRunRegistryItem["steps"][number]): string {
  const output = asRecord(step.output)
  const input = asRecord(step.input)
  const error = asRecord(step.error)

  if (error) {
    return String(error.message ?? error.code ?? "erro registrado")
  }

  if (step.type === "intent") {
    const intent = typeof output?.intent === "string" ? output.intent : null
    const reason = typeof output?.reason === "string" ? output.reason : null
    return [intent, reason].filter(Boolean).join(" · ") || "intenção registrada"
  }

  if (step.type === "plan") {
    const steps = Array.isArray(output?.steps) ? output.steps.length : null
    return steps ? `${steps} etapa(s) planejada(s)` : "plano registrado"
  }

  if (step.type === "rewrite") {
    const queries = Array.isArray(output?.queries)
      ? output.queries.filter((query): query is string => typeof query === "string")
      : []
    return queries.length > 0 ? queries.join(" | ") : "consulta mantida"
  }

  if (step.type === "retrieve") {
    const count = typeof output?.count === "number" ? output.count : null
    const retriever =
      typeof output?.retriever === "string"
        ? output.retriever
        : typeof input?.retriever === "string"
          ? input.retriever
          : null
    return [count != null ? `${count} trecho(s)` : null, retriever]
      .filter(Boolean)
      .join(" · ") || "recuperação registrada"
  }

  if (step.type === "evaluate") {
    const sufficient =
      typeof output?.sufficient === "boolean"
        ? output.sufficient
          ? "suficiente"
          : "insuficiente"
        : null
    const score = typeof output?.score === "number" ? formatScorePct(output.score) : null
    return [sufficient, score].filter(Boolean).join(" · ") || "avaliação registrada"
  }

  if (step.type === "tool") {
    const kind = typeof output?.kind === "string" ? output.kind : null
    const tool = typeof output?.tool === "string" ? output.tool : null
    const mode = typeof output?.mode === "string" ? output.mode : null
    return [tool ?? kind, mode].filter(Boolean).join(" · ") || "ferramenta registrada"
  }

  if (step.type === "generate") {
    const chars = typeof output?.chars === "number" ? `${output.chars} caractere(s)` : null
    const provider = typeof output?.provider === "string" ? output.provider : null
    return [chars, provider].filter(Boolean).join(" · ") || "resposta gerada"
  }

  if (step.type === "verify") {
    const faithful =
      typeof output?.faithful === "boolean"
        ? output.faithful
          ? "fiel"
          : "não fiel"
        : null
    const action = typeof output?.action === "string" ? output.action : null
    return [faithful, action].filter(Boolean).join(" · ") || "verificação registrada"
  }

  if (step.type === "fallback") {
    return typeof output?.reason === "string" ? output.reason : "fallback registrado"
  }

  return "etapa registrada"
}

export default function AssistantPage() {
  return (
    <AuthGate>
      <AssistantPageInner />
    </AuthGate>
  )
}

function AssistantPageInner() {
  const [patients, setPatients] = useState<PatientSummary[]>([])
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<PatientSummary | null>(null)
  const [docs, setDocs] = useState<PatientDocument[] | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [runRegistry, setRunRegistry] = useState<AgentRunRegistryItem[]>([])
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)
  const [registryLoading, setRegistryLoading] = useState(false)
  const [registryError, setRegistryError] = useState<string | null>(null)
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [ragOk, setRagOk] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    chatApi
      .health()
      .then((h) => setRagOk(!!h.ok))
      .catch(() => setRagOk(false))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => {
      patientsApi
        .list(search ? { search } : undefined)
        .then(setPatients)
        .catch((e) => setError((e as Error).message))
    }, 250)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  async function selectPatient(p: PatientSummary) {
    setSelected(p)
    setMessages([])
    setError(null)
    setDocs(null)
    setRunRegistry([])
    setExpandedRunId(null)
    setRegistryError(null)
    documentsApi
      .list(p.id)
      .then(setDocs)
      .catch(() => setDocs([]))
    try {
      // Reuse the most recent session for this patient so the conversation
      // history persists across reloads / patient re-selection. Only create
      // a new session if none exists yet.
      const existing = await chatApi.listSessions(p.id).catch(() => [])
      const session = existing[0] ?? (await chatApi.createSession(p.id))
      setSessionId(session.id)
      void loadRunRegistry(session.id, { expandLatest: true })
      const past = await chatApi.listMessages(session.id)
      setMessages(
        past.map((m: ChatMessage) => {
          const sources = (m.sources as SourceRef[] | undefined) ?? undefined
          const perChunk = (m.metricsPerChunk as number[] | null | undefined) ?? null
          const sourcesWithRelevance =
            sources && perChunk
              ? sources.map((s, i) => ({ ...s, relevance: perChunk[i] ?? s.relevance }))
              : sources
          return {
            id: m.id,
            role: m.role,
            content: m.content,
            sources: sourcesWithRelevance,
            metrics:
              m.contextRelevance != null ||
              m.groundedness != null ||
              m.answerRelevance != null
                ? {
                    contextRelevance: m.contextRelevance ?? null,
                    groundedness: m.groundedness ?? null,
                    answerRelevance: m.answerRelevance ?? null,
                }
                : undefined,
            agentRunId: m.agentRunId ?? undefined,
          }
        }),
      )
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function send() {
    const q = input.trim()
    if (!q || !sessionId || streaming) return

    // Slash-command branch: parsed locally, never hits the SSE stream.
    if (q.startsWith("/")) {
      setInput("")
      void runSlashCommand(q)
      return
    }

    setInput("")
    const userMsg: UiMessage = { id: `u-${Date.now()}`, role: "user", content: q }
    const assistantId = `a-${Date.now()}`
    setMessages((m) => [...m, userMsg, { id: assistantId, role: "assistant", content: "" }])
    setStreaming(true)
    setError(null)

    abortRef.current = streamChat(sessionId, q, {
      onSources(sources) {
        setMessages((m) =>
          m.map((msg) => (msg.id === assistantId ? { ...msg, sources } : msg)),
        )
      },
      onToken(token) {
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId ? { ...msg, content: msg.content + token } : msg,
          ),
        )
      },
      onMetrics(metrics: RagMetrics) {
        setMessages((m) =>
          m.map((msg) => {
            if (msg.id !== assistantId) return msg
            const sources =
              msg.sources && metrics.perChunk?.length
                ? msg.sources.map((s, i) => ({
                    ...s,
                    relevance: metrics.perChunk[i] ?? s.relevance,
                  }))
                : msg.sources
            return {
              ...msg,
              sources,
              metrics: {
                contextRelevance: metrics.contextRelevance,
                groundedness: metrics.groundedness,
                answerRelevance: metrics.answerRelevance,
              },
            }
          }),
        )
      },
      onStep(event) {
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? { ...msg, step: event.step, debug: mergeDebug(msg.debug, event) }
              : msg,
          ),
        )
      },
      onPreview(event: AgentPreviewEvent) {
        const action = previewToAction(event)
        if (!action) return
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? { ...msg, pendingAction: action }
              : msg,
          ),
        )
      },
      onDone(done) {
        setStreaming(false)
        if (done?.agentRunId) {
          void loadAgentTrace(assistantId, done.agentRunId)
        }
        void loadRunRegistry(sessionId, { expandLatest: true })
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? { ...msg, step: undefined, agentRunId: done?.agentRunId }
              : msg,
          ),
        )
      },
      onError(message) {
        setStreaming(false)
        setError(message)
      },
    })
  }

  function previewToAction(event: AgentPreviewEvent): ChatActionPayload | null {
    const kind = event.toolCall.name.replace(/^appointment\./, "")
    if (
      kind !== "create" &&
      kind !== "reschedule" &&
      kind !== "cancel" &&
      kind !== "approve" &&
      kind !== "reject" &&
      kind !== "list_upcoming"
    ) {
      return null
    }
    return {
      kind,
      mode: "commit",
      args: event.toolCall.args as ChatActionPayload["args"],
    }
  }

  function stop() {
    abortRef.current?.abort()
    setStreaming(false)
  }

  async function runSlashCommand(text: string) {
    if (!sessionId) return
    const userMsg: UiMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
    }
    setMessages((m) => [...m, userMsg])
    setError(null)

    const parsed = parseChatCommand(text)
    if (parsed.kind === "help" || parsed.kind === "error" || parsed.kind === "unknown") {
      const reply: UiMessage = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content:
          parsed.message ??
          "Comando desconhecido. Use /ajuda para ver os comandos.",
      }
      setMessages((m) => [...m, reply])
      return
    }

    // Action: run preview, then show confirmation card.
    try {
      const preview = await chatApi.runAction(sessionId, parsed.payload!)
      const reply: UiMessage = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: preview.message,
        // For list_upcoming there is nothing to commit — keep it as a plain reply.
        pendingAction:
          preview.kind === "list_upcoming"
            ? undefined
            : { ...parsed.payload!, mode: "commit" },
      }
      setMessages((m) => [...m, reply])
    } catch (err) {
      const reply: UiMessage = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: `Falha: ${errorMessage(err)}`,
      }
      setMessages((m) => [...m, reply])
    }
  }

  async function commitAction(messageId: string, payload: ChatActionPayload) {
    if (!sessionId) return
    // Prevent double-submit by clearing the pendingAction immediately.
    setMessages((m) =>
      m.map((msg) =>
        msg.id === messageId ? { ...msg, pendingAction: undefined } : msg,
      ),
    )
    try {
      const res: ChatActionResult = await chatApi.runAction(sessionId, payload)
      const reply: UiMessage = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: res.message,
      }
      setMessages((m) => [...m, reply])
    } catch (err) {
      const reply: UiMessage = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content: `Falha ao confirmar: ${errorMessage(err)}`,
      }
      setMessages((m) => [...m, reply])
    }
  }

  function dismissPending(messageId: string) {
    setMessages((m) =>
      m.map((msg) =>
        msg.id === messageId ? { ...msg, pendingAction: undefined } : msg,
      ),
    )
  }

  async function loadAgentTrace(messageId: string, runId: string) {
    setMessages((m) =>
      m.map((msg) =>
        msg.id === messageId
          ? { ...msg, traceLoading: true, traceError: undefined }
          : msg,
      ),
    )
    try {
      const trace = await agentApi.getRun(runId)
      setMessages((m) =>
        m.map((msg) =>
          msg.id === messageId
            ? { ...msg, agentTrace: trace, traceLoading: false }
            : msg,
        ),
      )
    } catch (err) {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === messageId
            ? { ...msg, traceLoading: false, traceError: errorMessage(err) }
            : msg,
        ),
      )
    }
  }

  async function loadRunRegistry(
    targetSessionId = sessionId,
    options: { expandLatest?: boolean } = {},
  ) {
    if (!targetSessionId) return
    setRegistryLoading(true)
    setRegistryError(null)
    try {
      const runs = await agentApi.listRuns({ sessionId: targetSessionId, limit: 20 })
      setRunRegistry(runs)
      if (options.expandLatest) {
        setExpandedRunId(runs[0]?.run.id ?? null)
      }
    } catch (err) {
      setRegistryError(errorMessage(err))
    } finally {
      setRegistryLoading(false)
    }
  }

  function mergeDebug(
    current: AgentDebugState | undefined,
    event: AgentStepEvent,
  ): AgentDebugState | undefined {
    const steps = [...(current?.steps ?? []), event]
    if (!event.data || typeof event.data !== "object") return { ...current, steps }
    const data = event.data as Record<string, unknown>
    if (event.step === "intent" && typeof data.intent === "string") {
      return { ...current, steps, intent: data.intent }
    }
    if (
      (event.step === "rewrite" || event.step === "retrieve") &&
      Array.isArray(data.queries)
    ) {
      return {
        ...current,
        steps,
        queries: data.queries.filter((q): q is string => typeof q === "string"),
      }
    }
    if (event.step === "evaluate") {
      return {
        ...current,
        steps,
        context: {
          sufficient:
            typeof data.sufficient === "boolean" ? data.sufficient : undefined,
          score: typeof data.score === "number" ? data.score : undefined,
          missing: Array.isArray(data.missing)
            ? data.missing.filter((m): m is string => typeof m === "string")
            : undefined,
        },
      }
    }
    if (event.step === "verify" && typeof data.faithful === "boolean") {
      return { ...current, steps, verified: data.faithful }
    }
    return { ...current, steps }
  }

  function openTrace(messageId: string, runId?: string) {
    if (!runId) return
    const message = messages.find((msg) => msg.id === messageId)
    if (!message?.agentTrace && !message?.traceLoading) {
      void loadAgentTrace(messageId, runId)
    }
  }

  function agentInspectionRows(message: UiMessage) {
    const liveSteps = message.debug?.steps ?? []
    const traceSteps = message.agentTrace?.steps ?? []
    const findLive = (name: string) =>
      [...liveSteps].reverse().find((step) => step.step === name)
    const findTrace = (name: string) =>
      [...traceSteps].reverse().find((step) => step.type === name)
    const retrieveSteps = traceSteps.filter((step) => step.type === "retrieve")
    const hadRetry = retrieveSteps.length > 1 || liveSteps.filter((step) => step.step === "retrieve").length > 1
    const stepData = (name: string) => {
      const trace = findTrace(name)
      if (trace) {
        return {
          model: trace.model ?? "sem chamada LLM registrada",
          tokensIn: trace.tokensIn ?? null,
          tokensOut: trace.tokensOut ?? null,
          durationMs: trace.durationMs ?? null,
          input: trace.input,
          output: trace.output,
          error: trace.error,
        }
      }
      return findLive(name)?.data
    }
    const rows = [
      {
        name: "1. Registrar pergunta",
        status: message.agentTrace ? "concluído" : "ao vivo",
        data: message.agentTrace?.run
          ? { question: message.agentTrace.run.question, runId: message.agentTrace.run.id }
          : undefined,
      },
      {
        name: "2. Classificar intenção",
        status: findTrace("intent") || findLive("intent") ? "concluído" : "pendente",
        data: stepData("intent"),
      },
      {
        name: "3. Planejar execução",
        status: findTrace("plan") || findLive("plan") ? "concluído" : "pendente",
        data: stepData("plan"),
      },
      {
        name: "4. Reescrever consulta",
        status: findTrace("rewrite") || findLive("rewrite") ? "concluído" : "pendente",
        data: stepData("rewrite"),
      },
      {
        name: "5. Recuperar evidências",
        status: findTrace("retrieve") || findLive("retrieve") ? "concluído" : "pendente",
        data: stepData("retrieve"),
      },
      {
        name: "6. Avaliar contexto",
        status: findTrace("evaluate") || findLive("evaluate") ? "concluído" : "pendente",
        data: stepData("evaluate"),
      },
      {
        name: "7. Retry corretivo",
        status: hadRetry ? "usado" : "não usado",
        data: retrieveSteps.length > 0 ? retrieveSteps.map((step) => step.output) : undefined,
      },
      {
        name: "8. Gerar resposta",
        status: findTrace("generate") || findLive("generate") ? "concluído" : "pendente",
        data: stepData("generate"),
      },
      {
        name: "9. Verificar resposta",
        status: findTrace("verify") || findLive("verify") ? "concluído" : "pendente",
        data: stepData("verify"),
      },
      {
        name: "10. Persistir trace",
        status: message.agentTrace ? "concluído" : message.agentRunId ? "disponível" : "pendente",
        data: message.agentTrace
          ? {
              steps: message.agentTrace.steps.length,
              chunks: message.agentTrace.chunks.length,
              fallbackUsed: message.agentTrace.run.fallbackUsed,
            }
          : undefined,
      },
    ]
    return rows
  }

  function inspectData(value: unknown): string {
    if (value == null) return "Sem dados registrados."
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <TopNav />
        <main className="flex-1 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Sparkles className="w-6 h-6 text-primary" />
              <div>
                <h1 className="text-2xl font-bold">Assistente clínico</h1>
                <p className="text-sm text-muted-foreground">
                  Resumos baseados nos documentos do paciente. Não substitui orientação médica.
                </p>
              </div>
            </div>
            <Badge variant={ragOk ? "default" : "destructive"} className="gap-2">
              <span
                className={`w-2 h-2 rounded-full ${
                  ragOk === null ? "bg-muted-foreground" : ragOk ? "bg-green-500" : "bg-red-500"
                }`}
              />
              {ragOk === null ? "Verificando..." : ragOk ? "Online" : "Offline"}
            </Badge>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Pacientes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Input
                  placeholder="Buscar por nome..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <ScrollArea className="h-[60vh]">
                  <div className="space-y-1">
                    {patients.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => selectPatient(p)}
                        className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                          selected?.id === p.id
                            ? "bg-primary text-primary-foreground"
                            : "hover:bg-muted"
                        }`}
                      >
                        <div className="font-medium">{p.fullName}</div>
                        {p.specialties && p.specialties.length > 0 ? (
                          <div className="text-xs opacity-70">
                            {p.specialties.join(", ")}
                          </div>
                        ) : null}
                      </button>
                    ))}
                    {patients.length === 0 ? (
                      <div className="text-sm text-muted-foreground px-3 py-2">
                        Nenhum paciente encontrado.
                      </div>
                    ) : null}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            <Card className="flex flex-col h-[70vh]">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                  {selected ? `Conversando sobre ${selected.fullName}` : "Selecione um paciente"}
                  {selected && docs ? (
                    docs.some((d) => d.ingestStatus === "ready") ? (
                      <Badge className="bg-green-600 hover:bg-green-600 text-xs">
                        {docs.filter((d) => d.ingestStatus === "ready").length} documento(s) pronto(s)
                      </Badge>
                    ) : docs.length > 0 ? (
                      <Badge variant="secondary" className="text-xs">
                        Documentos processando...
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">
                        Sem documentos
                      </Badge>
                    )
                  ) : null}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col gap-3 min-h-0">
                <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 pr-2">
                  {messages.length === 0 && selected ? (
                    <div className="text-sm text-muted-foreground space-y-1">
                      <div>
                        Faça uma pergunta sobre a anamnese, alergias, medicações ou tratamentos do paciente.
                      </div>
                      <div>
                        Para gerenciar agendamentos use comandos como{" "}
                        <code className="text-xs">/listar</code>,{" "}
                        <code className="text-xs">/criar</code>,{" "}
                        <code className="text-xs">/cancelar</code>. Digite{" "}
                        <code className="text-xs">/ajuda</code> para ver todos.
                      </div>
                    </div>
                  ) : null}
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={`rounded-lg px-3 py-2 max-w-[85%] ${
                        m.role === "user"
                          ? "ml-auto bg-primary text-primary-foreground"
                          : "bg-muted"
                      }`}
                    >
                      <div className="whitespace-pre-wrap text-sm">
                        {m.content || (streaming ? "Processando resposta clínica..." : "")}
                      </div>
                      {m.role === "assistant" && m.step && !m.content ? (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          Etapa: {m.step}
                        </div>
                      ) : null}
                      {m.role === "assistant" && m.debug ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {m.debug.intent ? (
                            <Badge variant="outline" className="text-[10px]">
                              Intent: {m.debug.intent}
                            </Badge>
                          ) : null}
                          {m.debug.queries?.map((query) => (
                            <Badge key={query} variant="secondary" className="text-[10px]">
                              Busca: {query}
                            </Badge>
                          ))}
                          {m.debug.context ? (
                            <Badge variant="outline" className="text-[10px]">
                              Contexto{" "}
                              {m.debug.context.sufficient === false ? "insuficiente" : "suficiente"}
                              {typeof m.debug.context.score === "number"
                                ? ` ${formatScorePct(m.debug.context.score)}`
                                : ""}
                            </Badge>
                          ) : null}
                          {typeof m.debug.verified === "boolean" ? (
                            <Badge
                              variant={m.debug.verified ? "default" : "destructive"}
                              className="text-[10px]"
                            >
                              {m.debug.verified ? "Verificado" : "Não verificado"}
                            </Badge>
                          ) : null}
                        </div>
                      ) : null}
                      {m.role === "assistant" && m.metrics ? (
                        <TooltipProvider>
                          <div className="mt-2 flex flex-wrap items-center gap-1">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge
                                  className={`${scoreColorClass(
                                    m.metrics.contextRelevance,
                                  )} text-[10px] gap-1 cursor-help`}
                                >
                                  Contexto {formatScorePct(m.metrics.contextRelevance)}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                Quão relevantes são os trechos recuperados para a pergunta.
                              </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge
                                  className={`${scoreColorClass(
                                    m.metrics.groundedness,
                                  )} text-[10px] gap-1 cursor-help`}
                                >
                                  Fidedignidade {formatScorePct(m.metrics.groundedness)}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                Quão bem a resposta se sustenta nos trechos recuperados (sem
                                alucinação).
                              </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge
                                  className={`${scoreColorClass(
                                    m.metrics.answerRelevance,
                                  )} text-[10px] gap-1 cursor-help`}
                                >
                                  Resposta {formatScorePct(m.metrics.answerRelevance)}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                Quão diretamente a resposta endereça a pergunta feita.
                              </TooltipContent>
                            </Tooltip>
                          </div>
                        </TooltipProvider>
                      ) : null}
                      {m.role === "assistant" && m.pendingAction ? (
                        <div className="mt-2 flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => commitAction(m.id, m.pendingAction!)}
                          >
                            Confirmar
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => dismissPending(m.id)}
                          >
                            Cancelar
                          </Button>
                        </div>
                      ) : null}
                      {m.role === "assistant" && (m.debug?.steps?.length || m.agentRunId) ? (
                        <details
                          className="mt-2 text-xs opacity-90"
                          onToggle={(event) => {
                            if ((event.currentTarget as HTMLDetailsElement).open) {
                              openTrace(m.id, m.agentRunId)
                            }
                          }}
                        >
                          <summary className="cursor-pointer">
                            Orquestração do agente
                            {m.traceLoading ? " · carregando trace..." : ""}
                          </summary>
                          {m.traceError ? (
                            <div className="mt-2 text-destructive">{m.traceError}</div>
                          ) : null}
                          <div className="mt-2 space-y-2">
                            {agentInspectionRows(m).map((row) => (
                              <div
                                key={row.name}
                                className="rounded-md border border-border/60 bg-background/60 p-2"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-medium">{row.name}</span>
                                  <Badge variant="outline" className="text-[10px]">
                                    {row.status}
                                  </Badge>
                                </div>
                                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                                  {inspectData(row.data)}
                                </pre>
                              </div>
                            ))}
                          </div>
                        </details>
                      ) : null}
                      {m.role === "assistant" && m.sources && m.sources.length > 0 ? (
                        <details className="mt-2 text-xs opacity-80">
                          <summary className="cursor-pointer">Fontes ({m.sources.length})</summary>
                          <ul className="mt-1 space-y-0.5">
                            {m.sources.map((s, i) => (
                              <li key={i}>
                                {s.source}
                                {typeof s.index === "number" ? ` #${s.index}` : ""}
                                {typeof s.relevance === "number"
                                  ? ` · ${formatScorePct(s.relevance)}`
                                  : ""}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </div>
                  ))}
                </div>

                {error ? (
                  <div className="flex items-center gap-2 text-sm text-destructive">
                    <AlertCircle className="w-4 h-4" /> {error}
                  </div>
                ) : null}

                <div className="flex items-center gap-2">
                  <Input
                    placeholder={
                      selected
                        ? "Pergunte algo ou use /ajuda"
                        : "Selecione um paciente"
                    }
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault()
                        send()
                      }
                    }}
                    disabled={!sessionId || streaming}
                  />
                  {streaming ? (
                    <Button variant="outline" onClick={stop}>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Parar
                    </Button>
                  ) : (
                    <Button onClick={send} disabled={!sessionId || !input.trim()}>
                      <Send className="w-4 h-4 mr-2" /> Enviar
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
              <div>
                <CardTitle className="text-base">Registro RAG</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Curso de ações persistido pela orquestração do agente.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadRunRegistry()}
                disabled={!sessionId || registryLoading}
              >
                <RefreshCw
                  className={`w-4 h-4 mr-2 ${registryLoading ? "animate-spin" : ""}`}
                />
                Atualizar
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              {!selected ? (
                <div className="text-sm text-muted-foreground">
                  Selecione um paciente para carregar o histórico RAG.
                </div>
              ) : registryError ? (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="w-4 h-4" /> {registryError}
                </div>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead>Execução</TableHead>
                        <TableHead>Pergunta</TableHead>
                        <TableHead>Intenção</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Etapas</TableHead>
                        <TableHead>Evidências</TableHead>
                        <TableHead>Duração</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runRegistry.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={8}
                            className="h-24 text-center text-sm text-muted-foreground"
                          >
                            {registryLoading
                              ? "Carregando execuções..."
                              : "Nenhuma execução RAG registrada para esta sessão."}
                          </TableCell>
                        </TableRow>
                      ) : (
                        runRegistry.map((run) => {
                          const status = runStatus(run)
                          const isExpanded = expandedRunId === run.run.id
                          const retrieveSteps = run.steps.filter(
                            (step) => step.type === "retrieve",
                          )
                          const chunkByStep = new Map<string, number>()
                          for (const chunk of run.chunks) {
                            if (!chunk.stepId) continue
                            chunkByStep.set(
                              chunk.stepId,
                              (chunkByStep.get(chunk.stepId) ?? 0) + 1,
                            )
                          }

                          return (
                            <Fragment key={run.run.id}>
                              <TableRow>
                                <TableCell>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8"
                                    onClick={() =>
                                      setExpandedRunId(isExpanded ? null : run.run.id)
                                    }
                                    aria-label={
                                      isExpanded
                                        ? "Recolher execução"
                                        : "Expandir execução"
                                    }
                                  >
                                    {isExpanded ? (
                                      <ChevronDown className="h-4 w-4" />
                                    ) : (
                                      <ChevronRight className="h-4 w-4" />
                                    )}
                                  </Button>
                                </TableCell>
                                <TableCell className="whitespace-nowrap align-top">
                                  <div className="font-mono text-xs">
                                    {shortId(run.run.id)}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {formatDateTime(run.run.createdAt)}
                                  </div>
                                </TableCell>
                                <TableCell className="min-w-[260px] max-w-[440px] align-top">
                                  <div className="line-clamp-2 text-sm">
                                    {run.run.question}
                                  </div>
                                </TableCell>
                                <TableCell className="whitespace-nowrap align-top text-sm">
                                  {run.run.intent ?? "n/a"}
                                </TableCell>
                                <TableCell className="align-top">
                                  <Badge variant={status.variant}>{status.label}</Badge>
                                </TableCell>
                                <TableCell className="whitespace-nowrap align-top text-sm">
                                  {run.steps.length}
                                </TableCell>
                                <TableCell className="whitespace-nowrap align-top text-sm">
                                  {run.chunks.length}
                                  {retrieveSteps.length > 1 ? (
                                    <span className="text-xs text-muted-foreground">
                                      {" "}
                                      em {retrieveSteps.length} buscas
                                    </span>
                                  ) : null}
                                </TableCell>
                                <TableCell className="whitespace-nowrap align-top text-sm">
                                  {formatDuration(run.run.totalLatencyMs)}
                                </TableCell>
                              </TableRow>
                              {isExpanded ? (
                                <TableRow>
                                  <TableCell colSpan={8} className="bg-muted/30 p-4">
                                    <div className="space-y-3">
                                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                                        {run.steps.map((step) => (
                                          <div
                                            key={step.id}
                                            className="rounded-md border bg-background p-3"
                                          >
                                            <div className="flex items-start justify-between gap-2">
                                              <div>
                                                <div className="font-medium text-sm">
                                                  {step.seq}. {stepLabel(step.type)}
                                                </div>
                                                <div className="mt-1 text-xs text-muted-foreground">
                                                  {summarizeStep(step)}
                                                </div>
                                              </div>
                                              <Badge variant="outline" className="text-[10px]">
                                                {formatDuration(step.durationMs)}
                                              </Badge>
                                            </div>
                                            <div className="mt-2 flex flex-wrap gap-1">
                                              {step.model ? (
                                                <Badge variant="secondary" className="text-[10px]">
                                                  {step.model}
                                                </Badge>
                                              ) : null}
                                              {step.tokensIn != null || step.tokensOut != null ? (
                                                <Badge variant="outline" className="text-[10px]">
                                                  {step.tokensIn ?? 0} in / {step.tokensOut ?? 0} out
                                                </Badge>
                                              ) : null}
                                              {chunkByStep.get(step.id) ? (
                                                <Badge variant="outline" className="text-[10px]">
                                                  {chunkByStep.get(step.id)} trecho(s)
                                                </Badge>
                                              ) : null}
                                            </div>
                                            <details className="mt-2 text-xs">
                                              <summary className="cursor-pointer text-muted-foreground">
                                                Dados brutos
                                              </summary>
                                              <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted p-2 whitespace-pre-wrap text-[11px]">
                                                {inspectData({
                                                  input: step.input,
                                                  output: step.output,
                                                  error: step.error,
                                                })}
                                              </pre>
                                            </details>
                                          </div>
                                        ))}
                                      </div>
                                      {run.chunks.length > 0 ? (
                                        <div className="rounded-md border bg-background p-3">
                                          <div className="font-medium text-sm">
                                            Evidências recuperadas
                                          </div>
                                          <div className="mt-2 grid gap-2 md:grid-cols-2">
                                            {run.chunks.map((chunk) => (
                                              <div
                                                key={chunk.id}
                                                className="rounded-md bg-muted p-2 text-xs"
                                              >
                                                <div className="font-mono">
                                                  {shortId(chunk.chunkId)}
                                                </div>
                                                <div className="mt-1 text-muted-foreground">
                                                  {chunk.source} #{chunk.chunkIndex}
                                                </div>
                                                <div className="mt-1 flex gap-2">
                                                  {chunk.score != null ? (
                                                    <span>
                                                      score {formatScorePct(chunk.score)}
                                                    </span>
                                                  ) : null}
                                                  {chunk.distance != null ? (
                                                    <span>
                                                      dist. {chunk.distance.toFixed(3)}
                                                    </span>
                                                  ) : null}
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      ) : null}
                                    </div>
                                  </TableCell>
                                </TableRow>
                              ) : null}
                            </Fragment>
                          )
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
