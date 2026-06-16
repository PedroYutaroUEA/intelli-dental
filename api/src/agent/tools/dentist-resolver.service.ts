import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ilike, inArray, isNotNull } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module';
import { clinicMembers, users } from '../../db/schemas';
import type { AgentContext } from '../contracts';

export interface DentistResolution {
  dentistId?: string;
  message?: string;
  candidates?: Array<{ id: string; fullName: string }>;
}

export interface ClinicDentist {
  id: string;
  fullName: string;
  cro: string | null;
}

@Injectable()
export class DentistResolverService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listAvailable(ctx: AgentContext): Promise<ClinicDentist[]> {
    return await this.db
      .select({
        id: users.id,
        fullName: users.fullName,
        cro: users.cro,
      })
      .from(clinicMembers)
      .innerJoin(users, eq(users.id, clinicMembers.userId))
      .where(
        and(
          eq(clinicMembers.clinicId, ctx.clinicId),
          inArray(clinicMembers.role, ['dentist', 'owner']),
          eq(clinicMembers.isActive, true),
          isNotNull(clinicMembers.acceptedAt),
        ),
      );
  }

  async resolveByName(ctx: AgentContext, rawName: string): Promise<DentistResolution> {
    const name = rawName.trim();
    if (name.length < 2) {
      return { message: 'Informe o nome do dentista.' };
    }

    const rows = await this.db
      .select({
        id: users.id,
        fullName: users.fullName,
      })
      .from(clinicMembers)
      .innerJoin(users, eq(users.id, clinicMembers.userId))
      .where(
        and(
          eq(clinicMembers.clinicId, ctx.clinicId),
          inArray(clinicMembers.role, ['dentist', 'owner']),
          eq(clinicMembers.isActive, true),
          isNotNull(clinicMembers.acceptedAt),
          ilike(users.fullName, `%${name}%`),
        ),
      )
      .limit(6);

    if (rows.length === 0) {
      return {
        message: `Não encontrei um dentista ativo nessa clínica com o nome "${name}".`,
      };
    }

    const normalized = this.normalize(name);
    const exact = rows.filter((row) => this.normalize(row.fullName) === normalized);
    if (exact.length === 1) {
      return { dentistId: exact[0].id };
    }
    if (rows.length === 1) {
      return { dentistId: rows[0].id };
    }

    return {
      message: `Encontrei mais de um dentista para "${name}". Informe o nome completo.`,
      candidates: rows.map((row) => ({ id: row.id, fullName: row.fullName })),
    };
  }

  private normalize(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }
}
