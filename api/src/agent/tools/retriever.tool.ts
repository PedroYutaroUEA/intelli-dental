import { Injectable, Logger, Optional } from '@nestjs/common';
import { RagService, type QueryHit, type RetrievedChunk as RagChunk } from '../../rag/rag.service';
import type { AgentContext, RetrievedChunk } from '../contracts';
import { AgentFeatureFlagsService } from '../config/agent-feature-flags.service';
import { PostgresRetrieverService } from './postgres-retriever.service';

@Injectable()
export class RetrieverTool {
  private readonly logger = new Logger(RetrieverTool.name);

  constructor(
    private readonly rag: RagService,
    @Optional() private readonly flags?: AgentFeatureFlagsService,
    @Optional() private readonly postgres?: PostgresRetrieverService,
  ) {}

  async retrieveMany(
    queries: string[],
    ctx: AgentContext,
    opts: { includeDatabase?: boolean; databaseOnly?: boolean } = {},
  ): Promise<RetrievedChunk[]> {
    const merged = new Map<string, RetrievedChunk>();

    if (!opts.databaseOnly) {
      for (const query of queries) {
        try {
          const res = await this.rag.retrieve({
            query,
            filters: { patientId: ctx.patientId },
            rerank: this.flags?.enabled('AGENT_RERANK_ENABLED', false) ?? false,
          });
          const chunks = res.chunks ?? res.hits?.map((hit) => this.hitToChunk(hit)) ?? [];
          this.mergeChunks(merged, chunks.map((chunk) => this.toChunk(chunk)));
        } catch (err) {
          if (!this.postgres) throw err;
          this.logger.warn(`rag retrieve failed, using postgres fallback: ${(err as Error).message}`);
          return this.postgres.retrieveMany(queries, ctx);
        }
      }
    }

    if ((opts.includeDatabase || opts.databaseOnly) && this.postgres) {
      try {
        this.mergeChunks(merged, await this.postgres.retrieveMany(queries, ctx));
      } catch (err) {
        if (opts.databaseOnly) throw err;
        this.logger.warn(`postgres retrieve failed, using vector-only results: ${(err as Error).message}`);
      }
    }

    return [...merged.values()].sort((a, b) => b.score - a.score);
  }

  private mergeChunks(target: Map<string, RetrievedChunk>, chunks: RetrievedChunk[]) {
    for (const chunk of chunks) {
      const prev = target.get(chunk.chunkId);
      if (!prev || chunk.score > prev.score) target.set(chunk.chunkId, chunk);
    }
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
