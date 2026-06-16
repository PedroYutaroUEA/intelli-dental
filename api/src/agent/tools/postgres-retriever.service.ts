import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DB, type Db } from '../../db/db.module';
import {
  anamneses,
  appointments,
  patientDocuments,
  patients,
} from '../../db/schemas';
import type { AgentContext, RetrievedChunk } from '../contracts';

type Candidate = Omit<RetrievedChunk, 'score' | 'distance'>;

@Injectable()
export class PostgresRetrieverService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async retrieveMany(queries: string[], ctx: AgentContext): Promise<RetrievedChunk[]> {
    const candidates = await this.loadCandidates(ctx);
    const terms = this.queryTerms(queries.join(' '));
    return candidates
      .map((candidate) => {
        const score = this.score(candidate.document, terms);
        return {
          ...candidate,
          score,
          distance: Math.max(0, 1 - score),
        };
      })
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  private async loadCandidates(ctx: AgentContext): Promise<Candidate[]> {
    const [patient] = await this.db
      .select()
      .from(patients)
      .where(
        and(
          eq(patients.id, ctx.patientId),
          eq(patients.clinicId, ctx.clinicId),
          isNull(patients.deletedAt),
        ),
      )
      .limit(1);

    if (!patient) return [];

    const [anamnesisRows, appointmentRows, documentRows] = await Promise.all([
      this.db
        .select()
        .from(anamneses)
        .where(
          and(
            eq(anamneses.patientId, ctx.patientId),
            eq(anamneses.clinicId, ctx.clinicId),
          ),
        )
        .orderBy(desc(anamneses.recordedAt))
        .limit(3),
      this.db
        .select()
        .from(appointments)
        .where(
          and(
            eq(appointments.patientId, ctx.patientId),
            eq(appointments.clinicId, ctx.clinicId),
          ),
        )
        .orderBy(desc(appointments.startsAt))
        .limit(10),
      this.db
        .select()
        .from(patientDocuments)
        .where(
          and(
            eq(patientDocuments.patientId, ctx.patientId),
            eq(patientDocuments.clinicId, ctx.clinicId),
          ),
        )
        .orderBy(desc(patientDocuments.createdAt))
        .limit(10),
    ]);

    const chunks: Candidate[] = [
      {
        chunkId: `postgres:patient:${patient.id}`,
        source: 'postgres:patient',
        index: 0,
        document: this.compactLines([
          'Cadastro do paciente',
          `Nome: ${patient.fullName}`,
          `Data de nascimento: ${patient.birthDate ?? 'não informado'}`,
          `Gênero: ${patient.gender ?? 'não informado'}`,
          `CPF: ${patient.cpf ?? 'não informado'}`,
          `Email: ${patient.email ?? 'não informado'}`,
          `Telefone: ${patient.phone ?? 'não informado'}`,
          `Endereço: ${patient.address ?? 'não informado'}`,
          `Especialidades: ${patient.specialties.join(', ') || 'não informado'}`,
          `Observações: ${patient.notes ?? 'não informado'}`,
        ]),
        metadata: {
          source: 'postgres:patient',
          sourceType: 'database',
          table: 'patients',
          patientId: ctx.patientId,
          clinicId: ctx.clinicId,
        },
      },
    ];

    anamnesisRows.forEach((row, index) => {
      chunks.push({
        chunkId: `postgres:anamnesis:${row.id}`,
        source: 'postgres:anamnesis',
        index,
        document: this.compactLines([
          `Anamnese registrada em ${row.recordedAt.toISOString()}`,
          `Especialidades: ${row.specialties.join(', ') || 'não informado'}`,
          `Queixa principal: ${row.chiefComplaint ?? 'não informado'}`,
          `História da doença atual: ${row.presentIllnessHistory ?? 'não informado'}`,
          `Alergias: ${row.allergiesSummary ?? 'não informado'}`,
          `Medicamentos: ${row.medicationsSummary ?? 'não informado'}`,
          `Em tratamento médico: ${row.underMedicalTreatment ? 'sim' : 'não'}`,
          `Gestante: ${this.booleanLabel(row.pregnant)}`,
          `Lactante: ${this.booleanLabel(row.lactating)}`,
          `Fumante: ${row.smoker ? 'sim' : 'não'}`,
          `Uso de álcool: ${row.alcoholUse ?? 'não informado'}`,
          `Bruxismo: ${row.bruxism ? 'sim' : 'não'}`,
          `Última visita ao dentista: ${row.lastDentalVisit ?? 'não informado'}`,
          `Consentimento assinado: ${row.consentSigned ? 'sim' : 'não'}`,
          `Respostas estruturadas: ${JSON.stringify(row.answers)}`,
        ]),
        metadata: {
          source: 'postgres:anamnesis',
          sourceType: 'database',
          table: 'anamneses',
          patientId: ctx.patientId,
          clinicId: ctx.clinicId,
          recordId: row.id,
        },
      });
    });

    appointmentRows.forEach((row, index) => {
      chunks.push({
        chunkId: `postgres:appointment:${row.id}`,
        source: 'postgres:appointment',
        index,
        document: this.compactLines([
          `Agendamento em ${row.startsAt.toISOString()}`,
          `Termina em: ${row.endsAt.toISOString()}`,
          `Status: ${row.status}`,
          `Motivo: ${row.reason ?? 'não informado'}`,
          `Notas: ${row.notes ?? 'não informado'}`,
          `Dentista: ${row.dentistId}`,
        ]),
        metadata: {
          source: 'postgres:appointment',
          sourceType: 'database',
          table: 'appointments',
          patientId: ctx.patientId,
          clinicId: ctx.clinicId,
          recordId: row.id,
        },
      });
    });

    documentRows.forEach((row, index) => {
      chunks.push({
        chunkId: `postgres:document:${row.id}`,
        source: 'postgres:document',
        index,
        document: this.compactLines([
          `Documento do paciente: ${row.filename}`,
          `Tipo MIME: ${row.mimeType}`,
          `Status de ingestão RAG: ${row.ingestStatus}`,
          `Erro de ingestão: ${row.ingestError ?? 'não informado'}`,
          `Quantidade de chunks: ${row.chunkCount ?? 'não informado'}`,
          `Enviado em: ${row.createdAt.toISOString()}`,
          `Ingerido em: ${row.ingestedAt?.toISOString() ?? 'não informado'}`,
        ]),
        metadata: {
          source: 'postgres:document',
          sourceType: 'database',
          table: 'patient_documents',
          patientId: ctx.patientId,
          clinicId: ctx.clinicId,
          recordId: row.id,
        },
      });
    });

    return chunks;
  }

  private score(document: string, terms: string[]): number {
    if (terms.length === 0) return 0.45;
    const normalized = this.normalize(document);
    const matches = terms.filter((term) => normalized.includes(term)).length;
    if (matches === 0) return 0.3;
    return Math.min(0.95, 0.45 + matches / terms.length);
  }

  private queryTerms(text: string): string[] {
    const stop = new Set([
      'a',
      'as',
      'de',
      'do',
      'da',
      'das',
      'dos',
      'e',
      'em',
      'o',
      'os',
      'para',
      'por',
      'que',
      'qual',
      'quais',
      'sobre',
    ]);
    return [...new Set(this.normalize(text).split(/\s+/).filter((term) => term.length > 2 && !stop.has(term)))];
  }

  private normalize(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private compactLines(lines: string[]): string {
    return lines.filter((line) => line.trim().length > 0).join('\n');
  }

  private booleanLabel(value: boolean | null): string {
    if (value == null) return 'não informado';
    return value ? 'sim' : 'não';
  }
}
