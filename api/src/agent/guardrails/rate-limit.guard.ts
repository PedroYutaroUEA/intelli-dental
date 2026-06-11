import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { AgentFeatureFlagsService } from '../config/agent-feature-flags.service';

interface Bucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class AgentRateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly flags: AgentFeatureFlagsService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest() as {
      user?: { userId?: string };
      clinicContext?: { clinicId?: string };
    };
    const limit = this.flags.int('AGENT_RATE_LIMIT_PER_MINUTE', 30);
    if (limit <= 0) return true;

    const userId = req.user?.userId ?? 'anonymous';
    const clinicId = req.clinicContext?.clinicId ?? 'no-clinic';
    const key = `${clinicId}:${userId}`;
    const now = Date.now();
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    current.count += 1;
    if (current.count > limit) {
      throw new HttpException('Limite de requisições do assistente excedido.', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
