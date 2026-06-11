import { Injectable } from '@nestjs/common';
import type { RetrievedChunk } from '../contracts';

@Injectable()
export class SanitizerService {
  private readonly patterns = [
    /ignore\s+(?:all\s+|the\s+)?(?:previous\s+|prior\s+|above\s+|earlier\s+)*instructions/i,
    /disregard\s+(?:all\s+|the\s+)?(?:previous\s+|prior\s+|above\s+)*(?:instructions|system prompt)/i,
    /reveal (your )?(system )?prompt/i,
    /\b(other|another) patient'?s?\b/i,
  ];

  sanitizeQuestion(question: string): string {
    return question.trim().slice(0, 2000);
  }

  sanitizeChunks(chunks: RetrievedChunk[]): RetrievedChunk[] {
    return chunks.map((chunk) => ({
      ...chunk,
      document: this.neutralize(chunk.document),
    }));
  }

  wrapContextAsData(chunks: RetrievedChunk[]): string {
    return chunks
      .map((chunk, index) => {
        const text = this.neutralize(chunk.document).replace(/>>>/g, '');
        return `[${index + 1}] source=${chunk.source}#${chunk.index}\n<<<${text}>>>`;
      })
      .join('\n\n');
  }

  flagInjection(text: string): boolean {
    return this.patterns.some((pattern) => pattern.test(text));
  }

  private neutralize(text: string): string {
    return text.replace(/>>>/g, '').replace(/```/g, "'''");
  }
}
