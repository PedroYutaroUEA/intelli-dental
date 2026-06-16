import { Injectable } from '@nestjs/common';
import type {
  AgentContext,
  ModelUsage,
  ToolManifestEntry,
  ToolSelectionResult,
} from '../contracts';
import { getPrompt } from '../prompts/registry';
import { ModelGatewayService } from '../../models/model-gateway.service';
import { DentistResolverService } from './dentist-resolver.service';
import { ToolRegistryService } from './tool-registry.service';

interface ParsedToolSelection {
  tool?: unknown;
  args?: unknown;
  missingArgs?: unknown;
  mode?: unknown;
}

@Injectable()
export class ToolSelectorService {
  constructor(
    private readonly gateway: ModelGatewayService,
    private readonly tools: ToolRegistryService,
    private readonly dentists?: DentistResolverService,
  ) {}

  async select(question: string, ctx: AgentContext): Promise<ToolSelectionResult> {
    const availableTools = this.tools.listAvailableTools(ctx);
    if (availableTools.length === 0) {
      return {
        tool: null,
        missingArgs: [],
        message: 'Não há ferramentas disponíveis para este usuário.',
      };
    }

    const prompt = getPrompt('tool_select');
    const res = await this.gateway.complete({
      task: 'tool_select',
      json: true,
      temperature: 0,
      maxTokens: 260,
      timeoutMs: 4000,
      messages: [
        { role: 'system', content: prompt.body },
        {
          role: 'user',
          content: JSON.stringify({
            question,
            locale: ctx.locale ?? 'pt-BR',
            currentDate: new Date().toISOString(),
            tools: availableTools,
          }),
        },
      ],
    });

    const parsed = (res.parsedJson ?? {}) as ParsedToolSelection;
    const toolName = typeof parsed.tool === 'string' ? parsed.tool : null;
    const tool = toolName
      ? availableTools.find((item) => item.name === toolName)
      : undefined;
    if (!tool) {
      return {
        tool: null,
        missingArgs: [],
        message: 'Não encontrei uma ferramenta disponível para executar esse pedido.',
        modelUsage: this.modelUsage(res),
      };
    }

    const args = this.cleanArgs(parsed.args, tool);
    const resolutionMessage = await this.resolveDentistName(tool, args, ctx);
    if (resolutionMessage) {
      return {
        tool: tool.name,
        missingArgs: ['dentistId'],
        message: resolutionMessage,
        modelUsage: this.modelUsage(res),
      };
    }
    const missingArgs = this.missingArgs(parsed.missingArgs, tool, args);
    if (missingArgs.length > 0) {
      return {
        tool: tool.name,
        missingArgs,
        message: this.missingArgsMessage(tool, missingArgs),
        modelUsage: this.modelUsage(res),
      };
    }

    return {
      tool: tool.name,
      action: {
        kind: tool.kind,
        mode: tool.defaultMode,
        args,
      },
      missingArgs: [],
      modelUsage: this.modelUsage(res),
    };
  }

  private cleanArgs(raw: unknown, tool: ToolManifestEntry): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const input = raw as Record<string, unknown>;
    const allowed = new Set(Object.keys(tool.inputSchema.properties));
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (!allowed.has(key) || value == null) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      out[key] = value;
    }
    return out;
  }

  private missingArgs(raw: unknown, tool: ToolManifestEntry, args: Record<string, unknown>): string[] {
    const modelMissing = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === 'string')
      : [];
    const missing = new Set<string>();
    for (const item of modelMissing) {
      if (tool.inputSchema.required.includes(item) && args[item] == null) missing.add(item);
    }
    for (const required of tool.inputSchema.required) {
      if (args[required] == null) missing.add(required);
    }
    return [...missing];
  }

  private async resolveDentistName(
    tool: ToolManifestEntry,
    args: Record<string, unknown>,
    ctx: AgentContext,
  ): Promise<string | undefined> {
    if (tool.kind !== 'create' || typeof args.dentistId === 'string') return undefined;
    if (typeof args.dentistName !== 'string') return undefined;
    if (!this.dentists) return 'Informe o ID do dentista.';

    const resolved = await this.dentists.resolveByName(ctx, args.dentistName);
    if (!resolved.dentistId) return resolved.message ?? 'Não encontrei esse dentista na clínica.';

    args.dentistId = resolved.dentistId;
    delete args.dentistName;
    return undefined;
  }

  private missingArgsMessage(tool: ToolManifestEntry, missingArgs: string[]): string {
    const fields = missingArgs.map((arg) => this.fieldLabel(arg)).join(', ');
    if (tool.kind === 'create') {
      return `Para criar o agendamento, preciso destes dados: ${fields}.`;
    }
    return `Para executar esta ação, preciso destes dados: ${fields}.`;
  }

  private fieldLabel(arg: string): string {
    const labels: Record<string, string> = {
      appointmentId: 'ID do agendamento',
      dentistId: 'dentista',
      startsAt: 'data e horário',
      durationMinutes: 'duração em minutos',
      reason: 'motivo',
      limit: 'limite',
    };
    return labels[arg] ?? arg;
  }

  private modelUsage(res: Awaited<ReturnType<ModelGatewayService['complete']>>): ModelUsage {
    return {
      model: res.model,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      latencyMs: res.latencyMs,
      fallbackModelUsed: res.fallbackModelUsed,
    };
  }
}
