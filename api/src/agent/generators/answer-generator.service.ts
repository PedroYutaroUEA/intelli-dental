import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModelGatewayService } from '../../models/model-gateway.service';
import { RagService } from '../../rag/rag.service';
import type {
  AgentContext,
  AgentStreamEvent,
  Citation,
  GeneratedAnswer,
  RetrievedChunk,
} from '../contracts';

const INSUFFICIENT_EVIDENCE =
  'Não encontrei evidências suficientes nos registros do paciente.';

export interface ParsedSseEvent {
  event?: string;
  data: string;
}

@Injectable()
export class AnswerGeneratorService {
  private readonly logger = new Logger(AnswerGeneratorService.name);

  constructor(
    private readonly rag: RagService,
    @Optional() private readonly gateway?: ModelGatewayService,
  ) {}

  async generate(
    question: string,
    evidence: RetrievedChunk[],
    ctx: AgentContext,
    emit?: (ev: AgentStreamEvent) => void,
  ): Promise<GeneratedAnswer> {
    if (evidence.length === 0) {
      return {
        text: INSUFFICIENT_EVIDENCE,
        citations: [],
      };
    }

    let text = '';
    let modelUsage: GeneratedAnswer['modelUsage'];
    try {
      const upstream = await this.rag.openGenerateStream({
        patientId: ctx.patientId,
        question,
        chunks: evidence.map((chunk) => ({
          chunkId: chunk.chunkId,
          document: chunk.document,
          source: chunk.source,
          index: chunk.index,
          score: chunk.score,
          metadata: chunk.metadata as Record<string, string | number | boolean>,
          distance: chunk.distance,
        })),
      });
      let buffer = '';
      for await (const chunk of upstream as AsyncIterable<Buffer | string>) {
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const evt = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const parsed = this.parseSseEvent(evt);
          if (!parsed || parsed.event === 'done') continue;
          if (parsed.event === 'error') throw new Error(parsed.data);
          const token = this.extractAssistantText(parsed);
          if (token.length > 0) {
            text += token;
            emit?.({ type: 'token', token });
          }
        }
      }
    } catch (err) {
      if (!this.gateway) throw err;
      this.logger.warn(`rag generate failed, using model gateway fallback: ${(err as Error).message}`);
      const generated = await this.generateViaGateway(question, evidence, ctx);
      text = generated.text;
      modelUsage = generated.modelUsage;
      if (text.length > 0) emit?.({ type: 'token', token: text });
    }

    return {
      text,
      citations: this.toCitations(evidence),
      modelUsage,
    };
  }

  parseSseEvent(raw: string): ParsedSseEvent | null {
    const lines = raw.split('\n');
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join('\n') };
  }

  extractAssistantText(parsed: ParsedSseEvent): string {
    if (parsed.event === 'token' || parsed.event === 'message') {
      try {
        const obj = JSON.parse(parsed.data) as { token?: string; content?: string };
        return obj.token ?? obj.content ?? '';
      } catch {
        return parsed.data;
      }
    }
    if (!parsed.event) {
      try {
        const value = JSON.parse(parsed.data);
        return typeof value === 'string' ? value : parsed.data;
      } catch {
        return parsed.data;
      }
    }
    return '';
  }

  private toCitations(chunks: RetrievedChunk[]): Citation[] {
    return chunks.map((chunk) => ({
      source: chunk.source,
      index: chunk.index,
      chunkId: chunk.chunkId,
      quote: chunk.document.slice(0, 240),
    }));
  }

  private async generateViaGateway(
    question: string,
    evidence: RetrievedChunk[],
    ctx: AgentContext,
  ): Promise<Pick<GeneratedAnswer, 'text' | 'modelUsage'>> {
    const context = evidence
      .map((chunk, i) => `[${i + 1}] source:${chunk.source}#${chunk.index}\n${chunk.document}`)
      .join('\n\n');
    const res = await this.gateway!.complete({
      task: 'generate',
      temperature: 0.2,
      maxTokens: 512,
      timeoutMs: 15000,
      messages: [
        {
          role: 'system',
          content:
            'You are a clinical assistant for a dental CRM. Answer using ONLY the provided CONTEXT. Cite every factual claim with source tags like [postgres:patient#0]. If the answer is not contained there, say you do not know based on the available records. Do not provide medical advice or diagnoses. Answer in the same language as the question.',
        },
        {
          role: 'user',
          content: `PATIENT_ID: ${ctx.patientId}\n\nCONTEXT:\n${context}\n\nQUESTION: ${question}`,
        },
      ],
    });
    return {
      text: res.text,
      modelUsage: {
        model: res.model,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        latencyMs: res.latencyMs,
        fallbackModelUsed: res.fallbackModelUsed,
      },
    };
  }
}
