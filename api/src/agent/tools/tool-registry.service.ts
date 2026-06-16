import { BadRequestException, Injectable } from '@nestjs/common';
import { ChatActionsService } from '../../chat/chat-actions.service';
import {
  CHAT_ACTION_KINDS,
  type ChatActionArgsDto,
  type ChatActionDto,
  type ChatActionKind,
} from '../../chat/dto/chat-action.dto';
import type {
  AgentContext,
  ToolCall,
  ToolInputPropertySchema,
  ToolInputSchema,
  ToolManifestEntry,
} from '../contracts';
import { PermissionService } from '../guardrails/permission.service';

interface RegisteredToolDefinition {
  name: string;
  kind: ChatActionKind;
  permission: string;
  mutating: boolean;
  manifest: ToolManifestEntry;
  validate(args: Record<string, unknown>): ChatActionArgsDto;
}

export interface ToolExecutionResult {
  message: string;
  data?: unknown;
  mutated: boolean;
  render?: unknown;
}

@Injectable()
export class ToolRegistryService {
  private readonly tools = new Map<string, RegisteredToolDefinition>();
  private readonly committedKeys = new Set<string>();

  constructor(
    private readonly actions: ChatActionsService,
    private readonly permissions: PermissionService,
  ) {
    for (const kind of CHAT_ACTION_KINDS) {
      const name = this.toolName(kind);
      const permission = kind === 'list_upcoming' ? 'rag:read' : 'appointment:write';
      const mutating = kind !== 'list_upcoming';
      this.tools.set(this.toolName(kind), {
        name,
        kind,
        permission,
        mutating,
        manifest: this.buildManifest(kind, name, permission, mutating),
        validate: (args) => this.validateAppointmentArgs(args),
      });
    }
  }

  listTools(): ToolManifestEntry[] {
    return CHAT_ACTION_KINDS.map((kind) => {
      const tool = this.tools.get(this.toolName(kind));
      if (!tool) throw new BadRequestException('Ferramenta desconhecida.');
      return this.cloneManifest(tool.manifest);
    });
  }

  listAvailableTools(ctx: AgentContext): ToolManifestEntry[] {
    return this.listTools().filter((tool) =>
      ctx.permissions.includes(tool.requiredPermission),
    );
  }

  async execute(ctx: AgentContext, action: ChatActionDto, confirmed = false, idempotencyKey?: string): Promise<{
    call: ToolCall;
    result: ToolExecutionResult;
  }> {
    const name = this.toolName(action.kind);
    const tool = this.tools.get(name);
    if (!tool) throw new BadRequestException('Ferramenta desconhecida.');
    this.permissions.assert(ctx, tool.permission);
    if (tool.mutating && action.mode === 'commit' && !confirmed) {
      throw new BadRequestException('Ferramentas mutáveis exigem confirmação antes do commit.');
    }
    let commitKey: string | undefined;
    if (tool.mutating && action.mode === 'commit') {
      if (!idempotencyKey) {
        throw new BadRequestException('A confirmação exige idempotencyKey.');
      }
      commitKey = `${ctx.agentRunId ?? ctx.sessionId}:${name}:${idempotencyKey}`;
      if (this.committedKeys.has(commitKey)) {
        throw new BadRequestException('Esta ação já foi confirmada.');
      }
    }

    const args = tool.validate((action.args ?? {}) as Record<string, unknown>);
    const safeAction: ChatActionDto = { kind: action.kind, mode: action.mode, args };
    const data = await this.actions.run(ctx, safeAction);
    if (commitKey) this.committedKeys.add(commitKey);
    const call: ToolCall = {
      id: `${ctx.agentRunId ?? 'run'}:${action.kind}`,
      name,
      args: args as Record<string, unknown>,
      mode: action.mode,
    };
    return {
      call,
      result: {
        message: data.message,
        data: data.data,
        mutated: tool.mutating && action.mode === 'commit',
        render: action.mode === 'preview' && tool.mutating
          ? { message: data.message, action: safeAction }
          : undefined,
      },
    };
  }

  private toolName(kind: ChatActionKind) {
    return `appointment.${kind}`;
  }

  private buildManifest(
    kind: ChatActionKind,
    name: string,
    permission: string,
    mutating: boolean,
  ): ToolManifestEntry {
    return {
      name,
      kind,
      description: this.descriptionFor(kind),
      requiredPermission: permission,
      mutating,
      confirmationRequired: mutating,
      defaultMode: 'preview',
      inputSchema: this.inputSchemaFor(kind),
      examples: this.examplesFor(kind),
    };
  }

  private descriptionFor(kind: ChatActionKind): string {
    const descriptions: Record<ChatActionKind, string> = {
      list_upcoming: 'Lista os próximos agendamentos do paciente da sessão.',
      create: 'Prepara a criação de um novo agendamento para o paciente da sessão.',
      reschedule: 'Prepara a remarcação de um agendamento existente do paciente da sessão.',
      cancel: 'Prepara o cancelamento de um agendamento existente do paciente da sessão.',
      approve: 'Prepara a confirmação de uma solicitação de agendamento pendente.',
      reject: 'Prepara a recusa de uma solicitação de agendamento pendente.',
    };
    return descriptions[kind];
  }

  private inputSchemaFor(kind: ChatActionKind): ToolInputSchema {
    const props = this.inputProperties();
    const requiredByKind: Record<ChatActionKind, string[]> = {
      list_upcoming: [],
      create: ['dentistId', 'startsAt', 'durationMinutes'],
      reschedule: ['appointmentId', 'startsAt'],
      cancel: ['appointmentId'],
      approve: ['appointmentId'],
      reject: ['appointmentId'],
    };
    const propertyNamesByKind: Record<ChatActionKind, string[]> = {
      list_upcoming: ['limit'],
      create: ['dentistId', 'dentistName', 'startsAt', 'durationMinutes', 'reason'],
      reschedule: ['appointmentId', 'startsAt', 'durationMinutes'],
      cancel: ['appointmentId', 'reason'],
      approve: ['appointmentId'],
      reject: ['appointmentId', 'reason'],
    };
    return {
      type: 'object',
      properties: Object.fromEntries(
        propertyNamesByKind[kind].map((propertyName) => [
          propertyName,
          props[propertyName],
        ]),
      ),
      required: requiredByKind[kind],
      additionalProperties: false,
    };
  }

  private inputProperties(): Record<string, ToolInputPropertySchema> {
    return {
      appointmentId: {
        type: 'string',
        format: 'uuid',
        description: 'ID do agendamento.',
      },
      dentistId: {
        type: 'string',
        format: 'uuid',
        description: 'ID do dentista responsável pelo agendamento. Use dentistName quando o usuário informar apenas o nome.',
      },
      dentistName: {
        type: 'string',
        maxLength: 200,
        description: 'Nome do dentista na clínica. Pode substituir dentistId em linguagem natural.',
      },
      startsAt: {
        type: 'string',
        format: 'date-time',
        description: 'Data e hora de início em ISO 8601.',
      },
      durationMinutes: {
        type: 'integer',
        minimum: 5,
        maximum: 480,
        description: 'Duração do agendamento em minutos.',
      },
      reason: {
        type: 'string',
        maxLength: 500,
        description: 'Motivo informado para a ação.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Quantidade máxima de agendamentos a listar.',
      },
    };
  }

  private examplesFor(kind: ChatActionKind): ToolManifestEntry['examples'] {
    const appointmentId = '11111111-1111-4111-8111-111111111111';
    const dentistId = '22222222-2222-4222-8222-222222222222';
    const examples: Record<ChatActionKind, ToolManifestEntry['examples']> = {
      list_upcoming: [
        { mode: 'preview', args: { limit: 5 } },
      ],
      create: [
        {
          mode: 'preview',
          args: {
            dentistName: 'Dra. Ana Silva',
            startsAt: '2026-07-10T14:00:00.000Z',
            durationMinutes: 45,
            reason: 'limpeza',
          },
        },
      ],
      reschedule: [
        {
          mode: 'preview',
          args: {
            appointmentId,
            startsAt: '2026-07-11T15:30:00.000Z',
            durationMinutes: 30,
          },
        },
      ],
      cancel: [
        { mode: 'preview', args: { appointmentId, reason: 'paciente solicitou' } },
      ],
      approve: [
        { mode: 'preview', args: { appointmentId } },
      ],
      reject: [
        { mode: 'preview', args: { appointmentId, reason: 'horário indisponível' } },
      ],
    };
    return examples[kind];
  }

  private cloneManifest(manifest: ToolManifestEntry): ToolManifestEntry {
    return JSON.parse(JSON.stringify(manifest)) as ToolManifestEntry;
  }

  private validateAppointmentArgs(args: Record<string, unknown>): ChatActionArgsDto {
    const out: ChatActionArgsDto = {};
    if (typeof args.appointmentId === 'string') out.appointmentId = args.appointmentId;
    if (typeof args.dentistId === 'string') out.dentistId = args.dentistId;
    if (typeof args.startsAt === 'string') out.startsAt = args.startsAt;
    if (typeof args.reason === 'string') out.reason = args.reason.slice(0, 500);
    if (typeof args.durationMinutes === 'number') {
      out.durationMinutes = Math.max(5, Math.min(480, Math.trunc(args.durationMinutes)));
    }
    if (typeof args.limit === 'number') {
      out.limit = Math.max(1, Math.min(50, Math.trunc(args.limit)));
    }
    return out;
  }
}
