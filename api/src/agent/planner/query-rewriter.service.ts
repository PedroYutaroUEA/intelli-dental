import { Injectable, Logger } from '@nestjs/common';
import { ModelGatewayService } from '../../models/model-gateway.service';
import type { AgentContext, RewriteResult } from '../contracts';
import { getPrompt } from '../prompts/registry';

@Injectable()
export class QueryRewriterService {
  private readonly logger = new Logger(QueryRewriterService.name);

  constructor(private readonly gateway: ModelGatewayService) {}

  async rewrite(question: string, ctx: AgentContext): Promise<RewriteResult> {
    try {
      const prompt = getPrompt('rewrite');
      const res = await this.gateway.complete({
        task: 'rewrite',
        json: true,
        temperature: 0,
        maxTokens: 220,
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
      const parsed = res.parsedJson as { queries?: unknown } | undefined;
      const queries = Array.isArray(parsed?.queries)
        ? parsed.queries.filter((q): q is string => typeof q === 'string')
        : [];
      const cleaned = this.clean(queries.length > 0 ? queries : [question]);
      return { queries: cleaned, modelUsage: this.modelUsage(res) };
    } catch (err) {
      this.logger.warn(`rewrite fallback: ${(err as Error).message}`);
      return { queries: this.clean([question]) };
    }
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

  private clean(queries: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of queries) {
      const q = raw.trim().slice(0, 500);
      const key = q.toLowerCase();
      if (q && !seen.has(key)) {
        seen.add(key);
        out.push(q);
      }
      if (out.length === 3) break;
    }
    return out.length > 0 ? out : [''];
  }
}
