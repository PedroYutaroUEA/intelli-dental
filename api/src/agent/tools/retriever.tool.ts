import { Injectable, Optional } from '@nestjs/common';
import { RagService, type QueryHit, type RetrievedChunk as RagChunk } from '../../rag/rag.service';
import type { AgentContext, RetrievedChunk } from '../contracts';
import { AgentFeatureFlagsService } from '../config/agent-feature-flags.service';

@Injectable()
export class RetrieverTool {
  constructor(
    private readonly rag: RagService,
    @Optional() private readonly flags?: AgentFeatureFlagsService,
  ) {}

  async retrieveMany(queries: string[], ctx: AgentContext): Promise<RetrievedChunk[]> {
    const merged = new Map<string, RetrievedChunk>();
    for (const query of queries) {
      const res = await this.rag.retrieve({
        query,
        filters: { patientId: ctx.patientId },
        rerank: this.flags?.enabled('AGENT_RERANK_ENABLED', false) ?? false,
      });
      const chunks = res.chunks ?? res.hits?.map((hit) => this.hitToChunk(hit)) ?? [];
      for (const ragChunk of chunks) {
        const chunk = this.toChunk(ragChunk);
        const prev = merged.get(chunk.chunkId);
        if (!prev || chunk.score > prev.score) merged.set(chunk.chunkId, chunk);
      }
    }
    return [...merged.values()].sort((a, b) => b.score - a.score);
  }

  private toChunk(chunk: RagChunk): RetrievedChunk {
    return {
      chunkId: chunk.chunkId,
      document: chunk.document,
      source: chunk.source,
      index: chunk.index,
      distance: chunk.distance,
      score: chunk.score,
      metadata: chunk.metadata,
    };
  }

  private hitToChunk(hit: QueryHit): RagChunk {
    const source = hit.metadata.source ?? hit.metadata.file ?? 'unknown';
    const index = Number(hit.metadata.index ?? hit.metadata.chunkIndex ?? 0);
    return {
      chunkId: hit.id,
      document: hit.document,
      source: String(source),
      index: Number.isFinite(index) ? index : 0,
      distance: hit.distance,
      score: Math.max(0, Math.min(1, 1 - hit.distance)),
      metadata: hit.metadata,
    };
  }
}
