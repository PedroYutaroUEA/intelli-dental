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
    const dentistList = await this.tryListDentists(question, ctx);
    if (dentistList) return dentistList;

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
    const tool = this.resolveTool(parsed.tool, availableTools, question);
    if (!tool) {
      return {
        tool: null,
        missingArgs: [],
        message: 'Não encontrei uma ferramenta disponível para executar esse pedido.',
        modelUsage: this.modelUsage(res),
      };
    }

    const args = this.cleanArgs(parsed.args, tool);
    this.applyHeuristicArgs(question, tool, args);
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

  private async tryListDentists(
    question: string,
    ctx: AgentContext,
  ): Promise<ToolSelectionResult | undefined> {
    if (!this.looksLikeDentistList(question)) return undefined;
    if (!this.dentists) {
      return {
        tool: 'clinic.list_dentists',
        missingArgs: [],
        message: 'Não consegui consultar os dentistas da clínica agora.',
      };
    }

    const dentists = await this.dentists.listAvailable(ctx);
    if (dentists.length === 0) {
      return {
        tool: 'clinic.list_dentists',
        missingArgs: [],
        message: 'Não encontrei dentistas ativos cadastrados nesta clínica.',
        data: { dentists },
      };
    }

    return {
      tool: 'clinic.list_dentists',
      missingArgs: [],
      message: [
        'Dentistas ativos nesta clínica:',
        ...dentists.map((dentist) =>
          `- ${dentist.fullName}${dentist.cro ? ` (CRO: ${dentist.cro})` : ''}`,
        ),
      ].join('\n'),
      data: { dentists },
    };
  }

  private looksLikeDentistList(question: string): boolean {
    const lower = question.toLowerCase();
    return (
      /\b(quais|liste|listar|mostre|mostrar|quem|dispon[ií]veis?|available|list|show|which)\b/.test(lower) &&
      /\b(dentistas?|drs?\.?|doutores?|profissionais?)\b/.test(lower)
    );
  }

  private resolveTool(
    rawTool: unknown,
    availableTools: ToolManifestEntry[],
    question: string,
  ): ToolManifestEntry | undefined {
    const toolName = typeof rawTool === 'string' ? rawTool.trim() : '';
    const direct = availableTools.find((item) => item.name === toolName);
    if (direct) return direct;

    const aliases: Record<string, string> = {
      create: 'appointment.create',
      criar: 'appointment.create',
      agendar: 'appointment.create',
      schedule: 'appointment.create',
      book: 'appointment.create',
      create_appointment: 'appointment.create',
      schedule_appointment: 'appointment.create',
      book_appointment: 'appointment.create',
      'appointment.schedule': 'appointment.create',
      'appointment.book': 'appointment.create',
    };
    const aliasedName = aliases[toolName.toLowerCase()];
    if (aliasedName) {
      const aliased = availableTools.find((item) => item.name === aliasedName);
      if (aliased) return aliased;
    }

    if (this.looksLikeAppointmentCreate(question)) {
      return availableTools.find((item) => item.name === 'appointment.create');
    }
    return undefined;
  }

  private looksLikeAppointmentCreate(question: string): boolean {
    const lower = question.toLowerCase();
    return (
      /\b(agende|agendar|agenda|marque|marcar|crie|criar|book|schedule)\b/.test(lower) &&
      /\b(consulta|agendamento|limpeza|atendimento|dentista|dr\.?|dra\.?)\b/.test(lower)
    );
  }

  private applyHeuristicArgs(
    question: string,
    tool: ToolManifestEntry,
    args: Record<string, unknown>,
  ) {
    if (tool.kind !== 'create') return;
    const dentistName = this.extractDentistName(question);
    if (typeof args.dentistId !== 'string' && dentistName) {
      args.dentistName = dentistName;
    }
    this.setMissingArg(args, 'startsAt', this.extractStartsAt(question));
    this.setMissingArg(args, 'durationMinutes', this.extractDurationMinutes(question));
    this.setMissingArg(args, 'reason', this.extractReason(question));
  }

  private setMissingArg(args: Record<string, unknown>, key: string, value: unknown) {
    if (args[key] == null && value != null) args[key] = value;
  }

  private extractDentistName(question: string): string | undefined {
    const match = question.match(
      /\b(?:com|para|pelo|pela)\s+(?:o\s+|a\s+)?((?:(?:dr\.?|dra\.?|doutor|doutora|dentista)\s+)?[\p{L}.' -]+?)(?=\s+(?:em|no|na|dia|às|as|por|para)\b|$)/iu,
    );
    return match?.[1]?.trim().replace(/\s+/g, ' ');
  }

  private extractStartsAt(question: string): string | undefined {
    const match = question.match(
      /\b(\d{4}-\d{2}-\d{2})\b.{0,24}?\b(?:às|as)?\s*(\d{1,2}):(\d{2})\b/i,
    );
    if (!match) return undefined;
    const hour = match[2].padStart(2, '0');
    const date = new Date(`${match[1]}T${hour}:${match[3]}:00`);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  private extractDurationMinutes(question: string): number | undefined {
    const match = question.match(/\bpor\s+(\d{1,3})\s*(?:min|mins|minutos?)\b/i);
    if (!match) return undefined;
    const minutes = Number(match[1]);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) return undefined;
    return minutes;
  }

  private extractReason(question: string): string | undefined {
    const match = question.match(/\bpara\s+(.+)$/i);
    const reason = match?.[1]?.trim();
    if (!reason || /\b(?:o\s+|a\s+)?(?:dr\.?|dra\.?|doutor|doutora|dentista)\b/i.test(reason)) {
      return undefined;
    }
    return reason.slice(0, 500);
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
