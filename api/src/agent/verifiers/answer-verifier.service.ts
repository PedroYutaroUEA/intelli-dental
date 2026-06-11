import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModelGatewayService } from '../../models/model-gateway.service';
import { AgentFeatureFlagsService } from '../config/agent-feature-flags.service';
import type { RetrievedChunk, VerificationResult } from '../contracts';
import { getPrompt } from '../prompts/registry';

@Injectable()
export class AnswerVerifierService {
  private readonly logger = new Logger(AnswerVerifierService.name);

  constructor(
    @Optional() private readonly gateway?: ModelGatewayService,
    @Optional() private readonly flags?: AgentFeatureFlagsService,
  ) {}

  async verify(
    answer: string,
    chunks: RetrievedChunk[],
    groundedness?: number | null,
  ): Promise<VerificationResult> {
    const cheap = this.cheapVerify(answer, chunks, groundedness);
    if (
      !this.gateway ||
      !this.flags?.enabled('AGENT_LLM_VERIFIER_ENABLED', false) ||
      cheap.action === 'pass'
    ) {
      return cheap;
    }

    try {
      const prompt = getPrompt('verify');
      const res = await this.gateway.complete({
        task: 'verify',
        json: true,
        temperature: 0,
        maxTokens: 260,
        timeoutMs: this.flags.int('AGENT_VERIFIER_TIMEOUT_MS', 3500),
        messages: [
          {
            role: 'system',
            content: prompt.body,
          },
          {
            role: 'user',
            content: JSON.stringify({
              answer,
              chunks: chunks.slice(0, 5).map((chunk) => ({
                source: chunk.source,
                index: chunk.index,
                text: chunk.document.slice(0, 700),
              })),
            }),
          },
        ],
      });
      const parsed = res.parsedJson as Partial<VerificationResult> | undefined;
      if (typeof parsed?.faithful === 'boolean') {
        const action = parsed.action === 'pass' && parsed.faithful ? 'pass' : 'downgrade';
        return {
          faithful: parsed.faithful,
          groundedness: cheap.groundedness,
          citationsOk: typeof parsed.citationsOk === 'boolean' ? parsed.citationsOk : cheap.citationsOk,
          unsupportedClaims: Array.isArray(parsed.unsupportedClaims)
            ? parsed.unsupportedClaims.filter((item): item is string => typeof item === 'string')
            : cheap.unsupportedClaims,
          action,
          method: 'hybrid',
        };
      }
    } catch (err) {
      this.logger.warn(`answer verifier fallback: ${(err as Error).message}`);
    }
    return cheap;
  }

  private cheapVerify(
    answer: string,
    chunks: RetrievedChunk[],
    groundedness?: number | null,
  ): VerificationResult {
    const threshold = this.flags?.float('AGENT_VERIFIER_GROUNDEDNESS_THRESHOLD', 0.25) ?? 0.25;
    const citationsOk = /\[[^\]]+#\d+\]/.test(answer) || chunks.length === 1;
    const score = groundedness ?? chunks[0]?.score ?? 0;
    const faithful = citationsOk && score >= threshold;
    return {
      faithful,
      groundedness: score,
      citationsOk,
      unsupportedClaims: faithful ? [] : ['missing_or_weak_citations'],
      action: faithful ? 'pass' : 'downgrade',
      method: 'hybrid',
    };
  }
}
