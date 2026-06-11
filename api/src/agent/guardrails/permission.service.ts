import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AgentContext } from '../contracts';

@Injectable()
export class PermissionService {
  assert(ctx: AgentContext, permission: string) {
    if (!ctx.permissions.includes(permission)) {
      throw new ForbiddenException('Permissão insuficiente para executar esta ferramenta.');
    }
  }
}
