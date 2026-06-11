import { Injectable } from '@nestjs/common';
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
  constructor(private readonly rag: RagService) {}

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

    return {
      text,
      citations: this.toCitations(evidence),
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
}
