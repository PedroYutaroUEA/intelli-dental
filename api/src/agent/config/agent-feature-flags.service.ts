import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface AgentFeatureFlags {
  router: boolean;
  queryRewrite: boolean;
  contextEvaluator: boolean;
  crag: boolean;
  toolCalling: boolean;
  verifier: boolean;
  debugEvents: boolean;
}

@Injectable()
export class AgentFeatureFlagsService {
  constructor(private readonly config: ConfigService) {}

  all(): AgentFeatureFlags {
    return {
      router: this.enabled('AGENT_ROUTER_ENABLED', true),
      queryRewrite: this.enabled('AGENT_QUERY_REWRITE_ENABLED', true),
      contextEvaluator: this.enabled('AGENT_CONTEXT_EVALUATOR_ENABLED', true),
      crag: this.enabled('AGENT_CRAG_ENABLED', true),
      toolCalling: this.enabled('AGENT_TOOL_CALLING_ENABLED', true),
      verifier: this.enabled('AGENT_VERIFIER_ENABLED', true),
      debugEvents: this.enabled('AGENT_DEBUG_EVENTS_ENABLED', false),
    };
  }

  enabled(name: string, fallback: boolean): boolean {
    const raw = this.config.get<string>(name);
    if (raw == null || raw.trim() === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  }

  int(name: string, fallback: number): number {
    const raw = this.config.get<string>(name);
    const value = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(value) ? value : fallback;
  }

  float(name: string, fallback: number): number {
    const raw = this.config.get<string>(name);
    const value = Number.parseFloat(raw ?? '');
    return Number.isFinite(value) ? value : fallback;
  }
}
