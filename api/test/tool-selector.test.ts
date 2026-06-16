import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { AgentContext } from '../src/agent/contracts';
import { PermissionService } from '../src/agent/guardrails/permission.service';
import { ToolSelectorService } from '../src/agent/tools/tool-selector.service';
import { ToolRegistryService } from '../src/agent/tools/tool-registry.service';

const context: AgentContext = {
  clinicId: 'clinic-1',
  userId: 'user-1',
  role: 'dentist',
  sessionId: 'session-1',
  patientId: 'patient-1',
  permissions: ['rag:read', 'appointment:write'],
  locale: 'pt-BR',
};

class MockGateway {
  calls: unknown[] = [];
  constructor(private readonly parsedJson: unknown) {}

  async complete(req: unknown) {
    this.calls.push(req);
    return {
      text: JSON.stringify(this.parsedJson),
      parsedJson: this.parsedJson,
      model: 'phi3:mini',
      tokensIn: 10,
      tokensOut: 5,
      latencyMs: 20,
      fallbackModelUsed: false,
    };
  }
}

function registry() {
  return new ToolRegistryService({ run: async () => undefined } as any, new PermissionService());
}

describe('ToolSelectorService', () => {
  it('selects appointment.create and forces mutating actions to preview', async () => {
    const gateway = new MockGateway({
      tool: 'appointment.create',
      mode: 'commit',
      args: {
        dentistId: '22222222-2222-4222-8222-222222222222',
        startsAt: '2026-07-10T14:00:00.000Z',
        durationMinutes: 45,
        reason: 'limpeza',
        extra: 'ignored',
      },
      missingArgs: [],
    });
    const selector = new ToolSelectorService(gateway as any, registry());

    const result = await selector.select('crie uma consulta', context);

    assert.equal(result.tool, 'appointment.create');
    assert.deepEqual(result.missingArgs, []);
    assert.deepEqual(result.action, {
      kind: 'create',
      mode: 'preview',
      args: {
        dentistId: '22222222-2222-4222-8222-222222222222',
        startsAt: '2026-07-10T14:00:00.000Z',
        durationMinutes: 45,
        reason: 'limpeza',
      },
    });
    assert.equal(result.modelUsage?.model, 'phi3:mini');
  });

  it('resolves dentistName to dentistId for appointment.create', async () => {
    const selector = new ToolSelectorService(
      new MockGateway({
        tool: 'appointment.create',
        mode: 'preview',
        args: {
          dentistName: 'Dra. Ana Silva',
          startsAt: '2026-07-10T14:00:00.000Z',
          durationMinutes: 45,
        },
        missingArgs: ['dentistId'],
      }) as any,
      registry(),
      {
        resolveByName: async (_ctx: AgentContext, name: string) => {
          assert.equal(name, 'Dra. Ana Silva');
          return { dentistId: '33333333-3333-4333-8333-333333333333' };
        },
      } as any,
    );

    const result = await selector.select('crie uma consulta com a Dra. Ana Silva', context);

    assert.deepEqual(result.missingArgs, []);
    assert.deepEqual(result.action, {
      kind: 'create',
      mode: 'preview',
      args: {
        dentistId: '33333333-3333-4333-8333-333333333333',
        startsAt: '2026-07-10T14:00:00.000Z',
        durationMinutes: 45,
      },
    });
  });

  it('does not build an action when dentistName cannot be resolved in the clinic', async () => {
    const selector = new ToolSelectorService(
      new MockGateway({
        tool: 'appointment.create',
        mode: 'preview',
        args: {
          dentistName: 'Dra. Não Cadastrada',
          startsAt: '2026-07-10T14:00:00.000Z',
          durationMinutes: 45,
        },
        missingArgs: [],
      }) as any,
      registry(),
      {
        resolveByName: async () => ({
          message: 'Não encontrei um dentista ativo nessa clínica com esse nome.',
        }),
      } as any,
    );

    const result = await selector.select('crie uma consulta com a Dra. Não Cadastrada', context);

    assert.equal(result.action, undefined);
    assert.deepEqual(result.missingArgs, ['dentistId']);
    assert.match(result.message ?? '', /dentista ativo/);
  });

  it('asks for missing required arguments instead of building an action', async () => {
    const selector = new ToolSelectorService(
      new MockGateway({
        tool: 'appointment.create',
        mode: 'preview',
        args: {
          startsAt: '2026-07-10T14:00:00.000Z',
        },
        missingArgs: ['dentistId', 'durationMinutes'],
      }) as any,
      registry(),
    );

    const result = await selector.select('crie uma consulta amanhã', context);

    assert.equal(result.tool, 'appointment.create');
    assert.equal(result.action, undefined);
    assert.deepEqual(result.missingArgs, ['dentistId', 'durationMinutes']);
    assert.match(result.message ?? '', /dentista/);
    assert.match(result.message ?? '', /duração/);
  });

  it('rejects tools that are not available to the context permissions', async () => {
    const selector = new ToolSelectorService(
      new MockGateway({
        tool: 'appointment.create',
        mode: 'preview',
        args: {
          dentistId: '22222222-2222-4222-8222-222222222222',
          startsAt: '2026-07-10T14:00:00.000Z',
          durationMinutes: 45,
        },
        missingArgs: [],
      }) as any,
      registry(),
    );

    const result = await selector.select('crie uma consulta', {
      ...context,
      permissions: ['rag:read'],
    });

    assert.equal(result.tool, null);
    assert.equal(result.action, undefined);
    assert.match(result.message ?? '', /ferramenta disponível/);
  });
});
