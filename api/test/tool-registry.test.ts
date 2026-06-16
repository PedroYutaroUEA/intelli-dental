import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { AgentContext } from '../src/agent/contracts';
import { PermissionService } from '../src/agent/guardrails/permission.service';
import { ToolRegistryService } from '../src/agent/tools/tool-registry.service';

const context: AgentContext = {
  clinicId: 'clinic-1',
  userId: 'user-1',
  role: 'dentist',
  sessionId: 'session-1',
  patientId: 'patient-1',
  permissions: ['rag:read'],
};

function registry() {
  let actionCalls = 0;
  const toolRegistry = new ToolRegistryService(
    {
      run: async () => {
        actionCalls += 1;
        return {
          ok: true,
          kind: 'list_upcoming',
          mode: 'preview',
          message: 'ok',
        };
      },
    } as any,
    new PermissionService(),
  );
  return {
    toolRegistry,
    actionCalls: () => actionCalls,
  };
}

describe('ToolRegistryService manifest', () => {
  it('lists all appointment tools in stable action order', () => {
    const { toolRegistry } = registry();

    const tools = toolRegistry.listTools();

    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        'appointment.list_upcoming',
        'appointment.create',
        'appointment.reschedule',
        'appointment.cancel',
        'appointment.approve',
        'appointment.reject',
      ],
    );
    assert.deepEqual(
      tools.map((tool) => tool.kind),
      ['list_upcoming', 'create', 'reschedule', 'cancel', 'approve', 'reject'],
    );
  });

  it('describes permissions, mutation, confirmation, and required args', () => {
    const { toolRegistry } = registry();
    const tools = new Map(toolRegistry.listTools().map((tool) => [tool.name, tool]));

    const listUpcoming = tools.get('appointment.list_upcoming');
    assert.ok(listUpcoming);
    assert.equal(listUpcoming.requiredPermission, 'rag:read');
    assert.equal(listUpcoming.mutating, false);
    assert.equal(listUpcoming.confirmationRequired, false);
    assert.deepEqual(listUpcoming.inputSchema.required, []);
    assert.deepEqual(Object.keys(listUpcoming.inputSchema.properties), ['limit']);

    const create = tools.get('appointment.create');
    assert.ok(create);
    assert.equal(create.requiredPermission, 'appointment:write');
    assert.equal(create.mutating, true);
    assert.equal(create.confirmationRequired, true);
    assert.deepEqual(create.inputSchema.required, [
      'dentistId',
      'startsAt',
      'durationMinutes',
    ]);
    assert.equal(create.inputSchema.properties.dentistId.format, 'uuid');
    assert.equal(create.inputSchema.properties.startsAt.format, 'date-time');
    assert.equal(create.inputSchema.properties.durationMinutes.minimum, 5);
    assert.equal(create.inputSchema.properties.durationMinutes.maximum, 480);
    assert.equal(create.inputSchema.properties.reason.maxLength, 500);

    const reschedule = tools.get('appointment.reschedule');
    assert.ok(reschedule);
    assert.deepEqual(reschedule.inputSchema.required, ['appointmentId', 'startsAt']);

    const cancel = tools.get('appointment.cancel');
    assert.ok(cancel);
    assert.deepEqual(cancel.inputSchema.required, ['appointmentId']);

    const approve = tools.get('appointment.approve');
    assert.ok(approve);
    assert.deepEqual(approve.inputSchema.required, ['appointmentId']);

    const reject = tools.get('appointment.reject');
    assert.ok(reject);
    assert.deepEqual(reject.inputSchema.required, ['appointmentId']);
  });

  it('filters manifest entries by context permissions', () => {
    const { toolRegistry } = registry();

    assert.deepEqual(
      toolRegistry.listAvailableTools(context).map((tool) => tool.name),
      ['appointment.list_upcoming'],
    );
    assert.deepEqual(
      toolRegistry
        .listAvailableTools({
          ...context,
          permissions: ['rag:read', 'appointment:write'],
        })
        .map((tool) => tool.name),
      [
        'appointment.list_upcoming',
        'appointment.create',
        'appointment.reschedule',
        'appointment.cancel',
        'appointment.approve',
        'appointment.reject',
      ],
    );
  });

  it('does not execute chat actions when reading manifests', () => {
    const { toolRegistry, actionCalls } = registry();

    toolRegistry.listTools();
    toolRegistry.listAvailableTools(context);

    assert.equal(actionCalls(), 0);
  });
});
