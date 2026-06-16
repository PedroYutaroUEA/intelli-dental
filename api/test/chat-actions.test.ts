import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ChatActionsService } from '../src/chat/chat-actions.service';

const ctx = {
  clinicId: 'clinic-1',
  userId: 'user-1',
  role: 'dentist' as const,
  sessionId: 'session-1',
  patientId: 'patient-1',
};

describe('ChatActionsService appointment create', () => {
  it('does not create an appointment during preview', async () => {
    let createCalls = 0;
    const service = new ChatActionsService(
      {} as any,
      {
        findOverlap: async () => null,
        create: async () => {
          createCalls += 1;
          throw new Error('create should not run for preview');
        },
      } as any,
    );

    const result = await service.run(ctx, {
      kind: 'create',
      mode: 'preview',
      args: {
        dentistId: 'dentist-1',
        startsAt: '2026-07-10T14:00:00.000Z',
        durationMinutes: 45,
        reason: 'limpeza',
      },
    });

    assert.equal(createCalls, 0);
    assert.equal(result.mode, 'preview');
    assert.match(result.message, /Prévia/);
    assert.match(result.message, /Confirme para salvar/);
  });

  it('creates and persists the assistant confirmation during commit', async () => {
    const createdMessages: unknown[] = [];
    const createInputs: unknown[] = [];
    const startsAt = new Date('2026-07-10T14:00:00.000Z');
    const service = new ChatActionsService(
      {
        appendMessage: async (...args: unknown[]) => {
          createdMessages.push(args);
        },
        touchSession: async () => undefined,
      } as any,
      {
        create: async (...args: unknown[]) => {
          createInputs.push(args);
          return {
            id: 'appointment-1',
            startsAt,
          };
        },
      } as any,
    );

    const result = await service.run(ctx, {
      kind: 'create',
      mode: 'commit',
      args: {
        dentistId: 'dentist-1',
        startsAt: startsAt.toISOString(),
        durationMinutes: 45,
        reason: 'limpeza',
      },
    });

    assert.equal(result.mode, 'commit');
    assert.match(result.message, /Agendamento criado/);
    assert.equal(createInputs.length, 1);
    assert.deepEqual(createInputs[0], [
      'clinic-1',
      'user-1',
      {
        patientId: 'patient-1',
        dentistId: 'dentist-1',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 45 * 60_000).toISOString(),
        reason: 'limpeza',
      },
    ]);
    assert.equal(createdMessages.length, 1);
  });
});
