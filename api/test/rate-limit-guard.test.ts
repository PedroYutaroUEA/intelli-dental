import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentRateLimitGuard } from '../src/agent/guardrails/rate-limit.guard';

function ctx() {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: { userId: 'user-1' },
        clinicContext: { clinicId: 'clinic-1' },
      }),
    }),
  } as any;
}

describe('AgentRateLimitGuard', () => {
  it('throws after the configured per-minute limit', () => {
    const guard = new AgentRateLimitGuard({ int: () => 1 } as any);

    assert.equal(guard.canActivate(ctx()), true);
    assert.throws(() => guard.canActivate(ctx()), /Limite de requisições/);
  });
});
