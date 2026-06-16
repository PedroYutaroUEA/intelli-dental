import { Injectable, Logger, Optional } from '@nestjs/common';
import { AgentFeatureFlagsService } from '../config/agent-feature-flags.service';
import type { ContextEvaluation, RetrievedChunk } from '../contracts';
import { ModelGatewayService } from '../../models/model-gateway.service';
import { getPrompt } from '../prompts/registry';

@Injectable()
export class ContextEvaluatorService {
  private readonly logger = new Logger(ContextEvaluatorService.name);

  constructor(
    @Optional() private readonly gateway?: ModelGatewayService,
    @Optional() private readonly flags?: AgentFeatureFlagsService,
  ) {}

  async evaluate(question: string, chunks: RetrievedChunk[]): Promise<ContextEvaluation> {
    const cheap = this.cheapEvaluate(question, chunks);
    if (!this.gateway || !this.flags?.enabled('AGENT_CONTEXT_LLM_EVALUATOR_ENABLED', false)) {
      return cheap;
    }

    const low = this.flags.float('AGENT_CONTEXT_BORDERLINE_LOW', 0.25);
    const high = this.flags.float('AGENT_CONTEXT_BORDERLINE_HIGH', 0.45);
    if (cheap.score < low || cheap.score > high) return cheap;

    try {
      const prompt = getPrompt('evaluate');
      const res = await this.gateway.complete({
        task: 'evaluate',
        json: true,
        temperature: 0,
        maxTokens: 220,
        timeoutMs: this.flags.int('AGENT_CONTEXT_EVALUATOR_TIMEOUT_MS', 3500),
        messages: [
          {
            role: 'system',
            content: prompt.body,
          },
          {
            role: 'user',
            content: JSON.stringify({
              question,
              chunks: chunks.slice(0, 5).map((chunk) => ({
                source: chunk.source,
                index: chunk.index,
                score: chunk.score,
                text: chunk.document.slice(0, 700),
              })),
            }),
          },
        ],
      });
      const parsed = res.parsedJson as Partial<ContextEvaluation> | undefined;
      if (typeof parsed?.sufficient === 'boolean') {
        return {
          sufficient: parsed.sufficient,
          score: typeof parsed.score === 'number' ? parsed.score : cheap.score,
          missing: Array.isArray(parsed.missing)
            ? parsed.missing.filter((item): item is string => typeof item === 'string')
            : cheap.missing,
          suggestedQuery:
            typeof parsed.suggestedQuery === 'string'
              ? parsed.suggestedQuery.slice(0, 500)
              : cheap.suggestedQuery,
          method: 'hybrid',
          modelUsage: this.modelUsage(res),
        };
      }
    } catch (err) {
      this.logger.warn(`context evaluator fallback: ${(err as Error).message}`);
    }
    return cheap;
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

  private cheapEvaluate(question: string, chunks: RetrievedChunk[]): ContextEvaluation {
    const threshold = this.flags?.float('AGENT_CONTEXT_SUFFICIENT_THRESHOLD', 0.35) ?? 0.35;
    const top = chunks[0]?.score ?? 0;
    const sufficient = chunks.length > 0 && top >= threshold;
    return {
      sufficient,
      score: top,
      missing: sufficient ? [] : chunks.length > 0 ? ['weak_context'] : ['no_context'],
      suggestedQuery: sufficient ? undefined : this.broaden(question),
      method: 'cosine',
    };
  }

  private broaden(question: string): string {
    return question
      .replace(/[?!.]+$/g, '')
      .replace(/\b(exatamente|especificamente|qual|quais|quando|onde)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  }
}
