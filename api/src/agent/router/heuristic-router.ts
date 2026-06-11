import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  ChatActionArgsDto,
  ChatActionDto,
  ChatActionKind,
} from '../../chat/dto/chat-action.dto';

export type AgentRoute =
  | { kind: 'rag' }
  | { kind: 'action'; action: ChatActionDto }
  | { kind: 'local'; message: string };

const HELP_TEXT = `Comandos disponíveis:
• /ajuda — exibe esta mensagem
• /listar [n] — mostra próximos agendamentos do paciente (até n, padrão 5)
• /criar dentista=<uuid> data=<YYYY-MM-DD HH:mm> duracao=<min> [motivo="..."]
• /remarcar <appointmentId> data=<YYYY-MM-DD HH:mm> [duracao=<min>]
• /cancelar <appointmentId> [motivo="..."]
• /confirmar <appointmentId>
• /recusar <appointmentId> [motivo="..."]`;

const KIND_BY_ALIAS: Record<string, ChatActionKind> = {
  listar: 'list_upcoming',
  criar: 'create',
  agendar: 'create',
  remarcar: 'reschedule',
  cancelar: 'cancel',
  confirmar: 'approve',
  aprovar: 'approve',
  recusar: 'reject',
  rejeitar: 'reject',
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class HeuristicRouter {
  route(question: string): AgentRoute {
    const text = question.trim();
    if (!text.startsWith('/')) return { kind: 'rag' };

    const space = text.indexOf(' ');
    const cmd = (space === -1 ? text.slice(1) : text.slice(1, space)).toLowerCase();
    const rest = space === -1 ? '' : text.slice(space + 1).trim();

    if (cmd === 'ajuda' || cmd === 'help') {
      return { kind: 'local', message: HELP_TEXT };
    }

    const action = KIND_BY_ALIAS[cmd];
    if (!action) {
      return {
        kind: 'local',
        message: `Comando desconhecido: /${cmd}. Use /ajuda para ver os comandos.`,
      };
    }

    return {
      kind: 'action',
      action: {
        kind: action,
        mode: 'preview',
        args: this.parseArgs(cmd, action, rest),
      },
    };
  }

  private parseArgs(
    cmd: string,
    action: ChatActionKind,
    rest: string,
  ): ChatActionArgsDto {
    const { positional, kv } = this.tokenize(rest);
    const args: ChatActionArgsDto = {};

    if (action === 'list_upcoming') {
      const limit =
        this.parseLimit(kv.limite) ??
        this.parseLimit(kv.limit) ??
        (positional[0] ? this.parseLimit(positional[0]) : undefined);
      if (limit) args.limit = limit;
      return args;
    }

    if (action === 'create') {
      const dentistId = (kv.dentista ?? kv.dentistid)?.trim();
      if (!dentistId || !UUID_RE.test(dentistId)) {
        throw new BadRequestException('dentista deve ser um UUID válido.');
      }

      const startsAt = this.parseDateTime(kv.data ?? kv.startsat);
      if (!startsAt) {
        throw new BadRequestException('Informe data=<YYYY-MM-DD HH:mm>.');
      }

      const durationMinutes = this.parseInt5to480(kv.duracao ?? kv.duration);
      if (!durationMinutes) {
        throw new BadRequestException(
          'Informe duracao=<minutos>, valor inteiro entre 5 e 480.',
        );
      }

      return {
        dentistId,
        startsAt,
        durationMinutes,
        reason: kv.motivo,
      };
    }

    const appointmentId = positional[0] ?? kv.id;
    if (!appointmentId || !UUID_RE.test(appointmentId)) {
      throw new BadRequestException(`Informe o ID do agendamento. Ex: /${cmd} <appointmentId>`);
    }
    args.appointmentId = appointmentId;

    if (action === 'reschedule') {
      const startsAt = this.parseDateTime(kv.data ?? kv.startsat);
      if (!startsAt) throw new BadRequestException('Informe data=<YYYY-MM-DD HH:mm>.');
      args.startsAt = startsAt;
      const duration = this.parseInt5to480(kv.duracao ?? kv.duration);
      if (duration) args.durationMinutes = duration;
    }

    if (action === 'cancel' || action === 'reject') {
      args.reason = kv.motivo;
    }

    return args;
  }

  private tokenize(rest: string): {
    positional: string[];
    kv: Record<string, string>;
  } {
    const positional: string[] = [];
    const kv: Record<string, string> = {};
    const re = /(\w+)=("([^"]*)"|(\S+))|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest)) !== null) {
      if (m[1]) kv[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : (m[4] ?? '');
      else if (m[5]) positional.push(m[5]);
    }
    return { positional, kv };
  }

  private parseDateTime(raw?: string): string | undefined {
    if (!raw) return undefined;
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const d = new Date(normalized);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }

  private parseInt5to480(raw?: string): number | undefined {
    if (raw == null) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 5 || n > 480) return undefined;
    return n;
  }

  private parseLimit(raw?: string): number | undefined {
    if (raw == null) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 50) return undefined;
    return n;
  }
}
