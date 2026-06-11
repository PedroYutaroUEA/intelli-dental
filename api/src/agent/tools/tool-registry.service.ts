import { BadRequestException, Injectable } from '@nestjs/common';
import { ChatActionsService } from '../../chat/chat-actions.service';
import {
  CHAT_ACTION_KINDS,
  type ChatActionArgsDto,
  type ChatActionDto,
  type ChatActionKind,
} from '../../chat/dto/chat-action.dto';
import type { AgentContext, ToolCall } from '../contracts';
import { PermissionService } from '../guardrails/permission.service';

interface ToolDefinition {
  name: string;
  permission: string;
  mutating: boolean;
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
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly committedKeys = new Set<string>();

  constructor(
    private readonly actions: ChatActionsService,
    private readonly permissions: PermissionService,
  ) {
    for (const kind of CHAT_ACTION_KINDS) {
      this.tools.set(this.toolName(kind), {
        name: this.toolName(kind),
        permission: kind === 'list_upcoming' ? 'rag:read' : 'appointment:write',
        mutating: kind !== 'list_upcoming',
        validate: (args) => this.validateAppointmentArgs(args),
      });
    }
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
