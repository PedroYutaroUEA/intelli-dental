import { Injectable, Logger } from '@nestjs/common';
import { ModelGatewayService } from '../../models/model-gateway.service';
import type { AgentContext, PlannedStep, QueryPlan } from '../contracts';
import { getPrompt } from '../prompts/registry';

@Injectable()
export class QueryPlannerService {
  private readonly logger = new Logger(QueryPlannerService.name);

  constructor(private readonly gateway: ModelGatewayService) {}

  static singleStep(question: string): QueryPlan {
    return {
      strategy: 'single',
      steps: [{ id: 'step-1', question }],
    };
  }

  async plan(question: string, ctx: AgentContext): Promise<QueryPlan> {
    try {
      const prompt = getPrompt('plan');
      const res = await this.gateway.complete({
        task: 'plan',
        json: true,
        temperature: 0,
        maxTokens: 320,
        timeoutMs: 4000,
        messages: [
          {
            role: 'system',
            content: prompt.body,
          },
          {
            role: 'user',
            content: JSON.stringify({ question, locale: ctx.locale ?? 'pt-BR' }),
          },
        ],
      });
      const parsed = res.parsedJson as { steps?: unknown } | undefined;
      const rawSteps = Array.isArray(parsed?.steps) ? parsed.steps : [];
      const steps = rawSteps
        .map((item) => this.toStep(item))
        .filter((step): step is PlannedStep => step != null)
        .slice(0, 4)
        .map((step, index) => ({ ...step, id: step.id || `step-${index + 1}` }));
      if (steps.length > 0) {
        return {
          strategy: steps.length === 1 ? 'single' : 'sequential',
          steps,
          modelUsage: this.modelUsage(res),
        };
      }
    } catch (err) {
      this.logger.warn(`planner fallback: ${(err as Error).message}`);
    }
    return QueryPlannerService.singleStep(question);
  }

  private modelUsage(res: Awaited<ReturnType<ModelGatewayService['complete']>>) {
    return {
      model: res.model,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      latencyMs: res.latencyMs,
      fallbackModelUsed: res.fallbackModelUsed,
    };
  }

  private toStep(item: unknown): PlannedStep | null {
    if (typeof item === 'string') {
      const question = this.cleanQuestion(item);
      return question ? { id: '', question } : null;
    }
    if (!item || typeof item !== 'object') return null;
    const obj = item as { id?: unknown; question?: unknown; dependsOn?: unknown };
    if (typeof obj.question !== 'string') return null;
    const question = this.cleanQuestion(obj.question);
    if (!question) return null;
    return {
      id: typeof obj.id === 'string' ? obj.id.slice(0, 64) : '',
      question,
      dependsOn: Array.isArray(obj.dependsOn)
        ? obj.dependsOn.filter((id): id is string => typeof id === 'string').slice(0, 4)
        : undefined,
    };
  }

  private cleanQuestion(question: string): string {
    return question.trim().replace(/\s+/g, ' ').slice(0, 500);
  }
}
