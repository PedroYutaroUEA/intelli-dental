import { Injectable, Logger } from '@nestjs/common';
import { ModelGatewayService } from '../../models/model-gateway.service';
import type { AgentContext, IntentResult } from '../contracts';
import { getPrompt } from '../prompts/registry';
import { HeuristicRouter } from './heuristic-router';

@Injectable()
export class IntentRouterService {
  private readonly logger = new Logger(IntentRouterService.name);

  constructor(
    private readonly gateway: ModelGatewayService,
    private readonly heuristics: HeuristicRouter,
  ) {}

  async classify(question: string, ctx: AgentContext): Promise<IntentResult> {
    const heuristic = this.fromHeuristic(question);
    if (heuristic.intent === 'action_request' || heuristic.localMessage) return heuristic;

    try {
      const prompt = getPrompt('intent');
      const res = await this.gateway.complete({
        task: 'intent',
        json: true,
        temperature: 0,
        maxTokens: 160,
        timeoutMs: 3500,
        messages: [
          {
            role: 'system',
            content: prompt.body,
          },
          {
            role: 'user',
            content: JSON.stringify({
              question,
              locale: ctx.locale ?? 'pt-BR',
            }),
          },
        ],
      });
      const parsed = res.parsedJson as Partial<IntentResult> | undefined;
      const intent = parsed?.intent;
      const confidence = Number(parsed?.confidence ?? 0);
      if (
        (intent === 'direct_answer' ||
          intent === 'knowledge_base_search' ||
          intent === 'database_query' ||
          intent === 'document_summary' ||
          intent === 'multi_step_question' ||
          intent === 'unsupported') &&
        confidence >= 0.65
      ) {
        return {
          intent,
          confidence,
          needsRetrieval:
            intent === 'knowledge_base_search' ||
            intent === 'document_summary' ||
            intent === 'multi_step_question',
          needsTool: intent === 'database_query',
          reason: String(parsed?.reason ?? 'llm'),
        };
      }
    } catch (err) {
      this.logger.warn(`intent fallback: ${(err as Error).message}`);
    }

    return heuristic;
  }

  private fromHeuristic(question: string): IntentResult {
    const route = this.heuristics.route(question);
    if (route.kind === 'local') {
      return {
        intent: 'direct_answer',
        confidence: 1,
        needsRetrieval: false,
        needsTool: false,
        reason: 'local_command',
        localMessage: route.message,
      };
    }
    if (route.kind === 'action') {
      return {
        intent: 'action_request',
        confidence: 1,
        needsRetrieval: false,
        needsTool: true,
        reason: 'slash_command',
        action: route.action,
      };
    }
    const lower = question.toLowerCase();
    if (/\b(resuma|resumir|resumo|sumarize)\b/.test(lower)) {
      return {
        intent: 'document_summary',
        confidence: 0.75,
        needsRetrieval: true,
        needsTool: false,
        reason: 'heuristic_summary',
      };
    }
    if (/[?].*[?]|\b(e também|compare|comparar|relação entre|relacao entre)\b/.test(lower)) {
      return {
        intent: 'multi_step_question',
        confidence: 0.7,
        needsRetrieval: true,
        needsTool: false,
        reason: 'heuristic_multi_step',
      };
    }
    if (/\b(agendamentos?|consultas?|cadastro|telefone|email)\b/.test(lower)) {
      return {
        intent: 'database_query',
        confidence: 0.7,
        needsRetrieval: false,
        needsTool: true,
        reason: 'heuristic_database_query',
      };
    }
    return {
      intent: 'knowledge_base_search',
      confidence: 0.7,
      needsRetrieval: true,
      needsTool: false,
      reason: 'heuristic_default',
    };
  }
}
