import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ModelRequest, ModelResponse, ModelTask } from '../agent/contracts';
import { InvalidJsonError, ModelUnavailableError } from '../agent/errors';
import { OllamaService } from './ollama.service';

const JSON_ONLY_INSTRUCTION = 'Responda APENAS com JSON válido, sem texto extra.';

interface TaskDefaults {
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  json: boolean;
}

@Injectable()
export class ModelGatewayService implements OnModuleInit {
  private readonly logger = new Logger(ModelGatewayService.name);
  private readonly defaultModel: string;

  constructor(
    private readonly config: ConfigService,
    private readonly ollama: OllamaService,
  ) {
    this.defaultModel =
      this.config.get<string>('AGENT_LLM_MODEL') ??
      this.config.get<string>('LLM_MODEL') ??
      'phi3:mini';
  }

  async onModuleInit() {
    if (!this.enabled('AGENT_WARMUP_ENABLED', true)) return;
    const models = new Set<string>([this.defaultModel]);
    for (const task of ['intent', 'rewrite', 'plan', 'evaluate', 'generate', 'verify', 'tool_select'] as ModelTask[]) {
      models.add(this.modelFor(task));
    }
    for (const model of models) {
      try {
        await this.ollama.warmup(model, this.int('AGENT_WARMUP_TIMEOUT_MS', 3000));
      } catch (err) {
        this.logger.warn(`model warmup failed for ${model}: ${(err as Error).message}`);
      }
    }
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const startedAt = Date.now();
    const defaults = this.defaultsFor(req.task);
    const json = req.json ?? defaults.json;
    const temperature = req.temperature ?? defaults.temperature;
    const maxTokens = req.maxTokens ?? defaults.maxTokens;
    const timeoutMs = req.timeoutMs ?? defaults.timeoutMs;
    const primaryModel = req.modelOverride ?? this.modelFor(req.task);
    const models = this.modelFallbacks(req.task, primaryModel);
    let lastError: unknown;

    for (const [modelIndex, model] of models.entries()) {
      const attempts = json ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const res = await this.ollama.chat(
            {
              model,
              messages: attempt === 0 ? req.messages : this.withJsonRetryInstruction(req.messages),
              format: json ? 'json' : undefined,
              options: {
                temperature,
                num_predict: maxTokens,
              },
            },
            timeoutMs,
            req.signal,
          );
          let parsedJson: unknown;
          if (json) parsedJson = this.parseJson(res.text);
          return {
            text: res.text,
            parsedJson,
            model,
            tokensIn: res.promptEvalCount,
            tokensOut: res.evalCount,
            latencyMs: Date.now() - startedAt,
            fallbackModelUsed: modelIndex > 0,
          };
        } catch (err) {
          lastError = err;
          this.logger.warn(
            `model ${req.task} ${model} attempt ${attempt + 1} failed: ${(err as Error).message}`,
          );
          if (err instanceof InvalidJsonError && attempt + 1 < attempts) continue;
          break;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new ModelUnavailableError('model request failed');
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      throw new InvalidJsonError();
    }
  }

  private withJsonRetryInstruction(messages: ModelRequest['messages']): ModelRequest['messages'] {
    return [
      ...messages,
      {
        role: 'user',
        content: JSON_ONLY_INSTRUCTION,
      },
    ];
  }

  private defaultsFor(task: ModelTask): TaskDefaults {
    const base: Record<ModelTask, TaskDefaults> = {
      intent: { temperature: 0, maxTokens: 160, timeoutMs: 3500, json: true },
      rewrite: { temperature: 0, maxTokens: 220, timeoutMs: 4000, json: true },
      plan: { temperature: 0, maxTokens: 320, timeoutMs: 5000, json: true },
      evaluate: { temperature: 0, maxTokens: 220, timeoutMs: 3500, json: true },
      generate: { temperature: 0.2, maxTokens: 512, timeoutMs: 15000, json: false },
      verify: { temperature: 0, maxTokens: 260, timeoutMs: 3500, json: true },
      tool_select: { temperature: 0, maxTokens: 220, timeoutMs: 3500, json: true },
    };
    return {
      temperature: this.float(`AGENT_${task.toUpperCase()}_TEMPERATURE`, base[task].temperature),
      maxTokens: this.int(`AGENT_${task.toUpperCase()}_MAX_TOKENS`, base[task].maxTokens),
      timeoutMs: this.int(`AGENT_${task.toUpperCase()}_TIMEOUT_MS`, base[task].timeoutMs),
      json: base[task].json,
    };
  }

  private modelFor(task: ModelTask): string {
    return (
      this.config.get<string>(`AGENT_${task.toUpperCase()}_MODEL`) ||
      this.defaultModel
    );
  }

  private modelFallbacks(task: ModelTask, primaryModel: string): string[] {
    if (task === 'plan') return this.unique([primaryModel, this.defaultModel, 'phi3:mini']);
    if (task === 'generate') {
      const fallback = this.config.get<string>('AGENT_GENERATE_FALLBACK_MODEL');
      return this.unique([primaryModel, fallback]);
    }
    return [primaryModel];
  }

  private unique(values: Array<string | undefined>): string[] {
    const out: string[] = [];
    for (const value of values) {
      if (value && !out.includes(value)) out.push(value);
    }
    return out;
  }

  private enabled(name: string, fallback: boolean): boolean {
    const value = this.config.get<string>(name);
    if (value == null) return fallback;
    return value === 'true' || value === '1';
  }

  private int(name: string, fallback: number): number {
    const value = Number(this.config.get<string>(name));
    return Number.isFinite(value) ? value : fallback;
  }

  private float(name: string, fallback: number): number {
    const value = Number(this.config.get<string>(name));
    return Number.isFinite(value) ? value : fallback;
  }
}
