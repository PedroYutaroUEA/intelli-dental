import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { request } from 'undici';

export interface IngestRequest {
  patientId: string;
  files: { path: string; mime?: string }[];
}

export interface IngestResponse {
  docs: number;
  chunks: number;
}

export interface ChatRequest {
  patientId: string;
  question: string;
  k?: number;
  rerank?: boolean;
}

export interface QueryHit {
  id: string;
  document: string;
  metadata: Record<string, string | number | boolean>;
  distance: number;
}

export interface RetrievedChunk {
  chunkId: string;
  document: string;
  source: string;
  index: number;
  distance: number;
  score: number;
  metadata: Record<string, string | number | boolean>;
}

export interface SourceRef {
  source: string | number | boolean;
  index: string | number | boolean;
  distance: number;
  score?: number;
}

export interface RetrieveRequest {
  patientId?: string;
  question?: string;
  query?: string;
  k?: number;
  rerank?: boolean;
  filters?: {
    patientId?: string;
    source?: string;
    sourceType?: string;
    sourceTypes?: ('anamnesis' | 'document' | 'appointment')[];
    documentVersion?: string;
    corpusVersion?: number;
  };
}

export interface RetrieveResponse {
  chunks: RetrievedChunk[];
  queryEcho: string;
  tookMs: number;
  hits?: QueryHit[];
  sources?: SourceRef[];
}

export interface GenerateRequest {
  patientId: string;
  question: string;
  hits?: QueryHit[];
  chunks?: RetrievedChunk[];
}

export interface EvaluateRequest {
  question: string;
  answer?: string;
  hits?: QueryHit[];
  chunks?: RetrievedChunk[];
}

export interface RagMetrics {
  contextRelevance: number;
  groundedness: number;
  answerRelevance: number;
  perChunk: number[];
}

export interface EmbedRequest {
  texts: string[];
}

export interface EmbedResponse {
  model: string;
  embeddings: number[][];
}

/**
 * Thin client around the rag-pipeline REST service.
 *
 * The frontend NEVER calls rag-pipeline directly. The API is the trust
 * boundary and proxies chat/ingest calls authenticated by a shared bearer
 * token (`RAG_AUTH_TOKEN`).
 */
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.baseUrl = (config.get<string>('RAG_URL') ?? 'http://localhost:3000').replace(/\/$/, '');
    this.token = config.get<string>('RAG_AUTH_TOKEN');
  }

  private headers(extra: Record<string, string> = {}) {
    const h: Record<string, string> = { 'content-type': 'application/json', ...extra };
    if (this.token) h['authorization'] = `Bearer ${this.token}`;
    return h;
  }

  async health() {
    try {
      const res = await request(`${this.baseUrl}/v1/health`, {
        method: 'GET',
        headers: this.headers(),
      });
      const body = (await res.body.json()) as Record<string, unknown>;
      return { ok: res.statusCode < 500, ...body };
    } catch (err) {
      this.logger.warn(`rag /health unreachable: ${(err as Error).message}`);
      return { ok: false };
    }
  }

  async ingest(req: IngestRequest): Promise<IngestResponse> {
    const res = await request(`${this.baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(req),
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new ServiceUnavailableException(`rag ingest failed: ${res.statusCode} ${text}`);
    }
    return (await res.body.json()) as IngestResponse;
  }

  async listSources(patientId: string) {
    const res = await request(
      `${this.baseUrl}/v1/patients/${encodeURIComponent(patientId)}/sources`,
      { method: 'GET', headers: this.headers() },
    );
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new ServiceUnavailableException(`rag listSources failed: ${res.statusCode} ${text}`);
    }
    return (await res.body.json()) as { sources: string[] };
  }

  async deletePatientSource(patientId: string, source?: string) {
    const url = new URL(
      `${this.baseUrl}/v1/patients/${encodeURIComponent(patientId)}/sources`,
    );
    if (source) url.searchParams.set('source', source);
    const res = await request(url.toString(), {
      method: 'DELETE',
      headers: this.headers(),
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new ServiceUnavailableException(`rag delete failed: ${res.statusCode} ${text}`);
    }
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const res = await request(`${this.baseUrl}/v1/embed`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(req),
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new ServiceUnavailableException(`rag embed failed: ${res.statusCode} ${text}`);
    }
    return (await res.body.json()) as EmbedResponse;
  }

  async retrieve(req: RetrieveRequest): Promise<RetrieveResponse> {
    const res = await request(`${this.baseUrl}/v1/retrieve`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(req),
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new ServiceUnavailableException(`rag retrieve failed: ${res.statusCode} ${text}`);
    }
    return (await res.body.json()) as RetrieveResponse;
  }

  async evaluate(req: EvaluateRequest): Promise<RagMetrics> {
    const res = await request(`${this.baseUrl}/v1/evaluate`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(req),
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new ServiceUnavailableException(`rag evaluate failed: ${res.statusCode} ${text}`);
    }
    return (await res.body.json()) as RagMetrics;
  }

  async openGenerateStream(req: GenerateRequest) {
    const res = await request(`${this.baseUrl}/v1/generate`, {
      method: 'POST',
      headers: this.headers({ accept: 'text/event-stream' }),
      body: JSON.stringify(req),
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new ServiceUnavailableException(`rag generate failed: ${res.statusCode} ${text}`);
    }
    return res.body;
  }

  /**
   * Open a streaming /v1/chat connection. Returns the raw response body
   * (an SSE event-stream) to be piped to the API client unchanged.
   */
  async openChatStream(req: ChatRequest) {
    const res = await request(`${this.baseUrl}/v1/chat`, {
      method: 'POST',
      headers: this.headers({ accept: 'text/event-stream' }),
      body: JSON.stringify(req),
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new ServiceUnavailableException(`rag chat failed: ${res.statusCode} ${text}`);
    }
    return res.body; // ReadableStream-like
  }
}
