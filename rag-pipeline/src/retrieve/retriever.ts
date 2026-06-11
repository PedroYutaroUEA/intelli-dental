import { embed } from "../embed/ollamaEmbeddings.js";
import { queryByEmbedding, type QueryHit } from "../store/chromaClient.js";

export interface RetrieveFilters {
  patientId?: string;
  source?: string;
  sourceType?: string;
  sourceTypes?: string[];
  documentVersion?: string;
  corpusVersion?: number;
}

export interface RetrieveOptions {
  patientId: string;
  question: string;
  k?: number;
  filters?: RetrieveFilters;
}

export async function retrieve(opts: RetrieveOptions): Promise<QueryHit[]> {
  const k = opts.k ?? 8;
  const [vec] = await embed([opts.question]);
  if (!vec) return [];
  const sourceTypes = opts.filters?.sourceTypes;
  if (sourceTypes && sourceTypes.length > 1) {
    const hits = await Promise.all(
      sourceTypes.map((sourceType) =>
        queryByEmbedding(vec, k, buildWhere(opts.patientId, { ...opts.filters, sourceTypes: undefined, sourceType })),
      ),
    );
    return dedupeHits(hits.flat()).slice(0, k);
  }
  return queryByEmbedding(vec, k, buildWhere(opts.patientId, opts.filters));
}

function buildWhere(
  patientId: string,
  filters?: RetrieveFilters,
): Record<string, string | number | boolean> {
  return {
    patientId: filters?.patientId ?? patientId,
    ...(filters?.source ? { source: filters.source } : {}),
    ...(filters?.sourceType ? { sourceType: filters.sourceType } : {}),
    ...(filters?.sourceTypes?.length === 1 ? { sourceType: filters.sourceTypes[0] } : {}),
    ...(filters?.documentVersion
      ? { documentVersion: filters.documentVersion }
      : {}),
    ...(typeof filters?.corpusVersion === "number"
      ? { corpusVersion: filters.corpusVersion }
      : {}),
  };
}

function dedupeHits(hits: QueryHit[]): QueryHit[] {
  const byId = new Map<string, QueryHit>();
  for (const hit of hits) {
    const prev = byId.get(hit.id);
    if (!prev || hit.distance < prev.distance) byId.set(hit.id, hit);
  }
  return [...byId.values()].sort((a, b) => a.distance - b.distance);
}
