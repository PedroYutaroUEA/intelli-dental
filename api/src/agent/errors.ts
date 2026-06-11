export class AgentError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly safeMessage = 'Não foi possível concluir a solicitação com segurança.',
  ) {
    super(message);
  }
}

export class BudgetExceededError extends AgentError {
  constructor(message = 'Agent budget exceeded') {
    super(message, 'budget_exceeded', 'A solicitação excedeu o limite de processamento.');
  }
}

export class GuardrailViolationError extends AgentError {
  constructor(message = 'Guardrail violation') {
    super(message, 'guardrail_violation', 'Não posso atender a esse pedido com segurança.');
  }
}

export class ToolExecutionError extends AgentError {
  constructor(message = 'Tool execution failed') {
    super(message, 'tool_execution_failed', 'Não foi possível executar a ação solicitada.');
  }
}

export class ModelUnavailableError extends AgentError {
  constructor(message = 'Model unavailable') {
    super(message, 'model_unavailable', 'O modelo de linguagem está indisponível no momento.');
  }
}

export class ModelTimeoutError extends AgentError {
  constructor(message = 'Model request timed out') {
    super(message, 'model_timeout', 'O modelo demorou demais para responder.');
  }
}

export class InvalidJsonError extends AgentError {
  constructor(message = 'Invalid model JSON') {
    super(message, 'invalid_model_json', 'O modelo retornou uma resposta inválida.');
  }
}

export function toSafeAgentError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AgentError(message, 'agent_failed');
}
