export const HARD_RULES = {
  NEVER_ANSWER_UNSUPPORTED: 'Factual claims must be backed by retrieved chunks.',
  NEVER_TOOL_WITHOUT_PERM: 'Tool execution requires the configured permission.',
  NEVER_MUTATE_WITHOUT_CONFIRM: 'Mutating tools require preview and explicit confirmation.',
  NEVER_EXPOSE_PROMPTS: 'System/internal prompts are never serialized into client responses.',
  NEVER_IGNORE_TENANT_FILTER: 'Retrieval requires patientId filtering at API and RAG boundaries.',
  ALWAYS_SAFE_FALLBACK: 'Insufficient evidence returns the canonical fallback.',
} as const;
