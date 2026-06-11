import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { request } from 'undici';
import { ModelTimeoutError, ModelUnavailableError } from '../agent/errors';
import type { ModelMessage } from '../agent/contracts';

export interface OllamaChatRequest {
  model: string;
  messages: ModelMessage[];
  stream?: boolean;
  format?: 'json';
  options?: {
    temperature?: number;
    num_predict?: number;
  };
  keep_alive?: string;
}

export interface OllamaChatResponse {
  text: string;
  promptEvalCount: number;
  evalCount: number;
}

@Injectable()
export class OllamaService {
  private readonly baseUrl: string;
  private readonly keepAlive: string;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('OLLAMA_URL') ?? 'http://localhost:11434').replace(/\/$/, '');
    this.keepAlive = config.get<string>('OLLAMA_KEEP_ALIVE') ?? '10m';
  }

  async chat(
    body: OllamaChatRequest,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<OllamaChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await request(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...body,
          stream: body.stream ?? false,
          keep_alive: body.keep_alive ?? this.keepAlive,
        }),
        signal: controller.signal,
      });
      if (res.statusCode >= 400) {
        throw new ModelUnavailableError(`Ollama ${res.statusCode}: ${await res.body.text()}`);
      }
      const json = (await res.body.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      return {
        text: json.message?.content ?? '',
        promptEvalCount: json.prompt_eval_count ?? 0,
        evalCount: json.eval_count ?? 0,
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new ModelTimeoutError(`Ollama request timed out after ${timeoutMs}ms`);
      }
      if (err instanceof ModelUnavailableError || err instanceof ModelTimeoutError) throw err;
      throw new ModelUnavailableError((err as Error).message);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async warmup(model: string, timeoutMs = 3000): Promise<void> {
    await this.chat(
      {
        model,
        messages: [{ role: 'user', content: 'ok' }],
        options: { temperature: 0, num_predict: 1 },
      },
      timeoutMs,
    );
  }
}
