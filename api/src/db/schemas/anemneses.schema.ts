import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.schema";
import { patients } from "./patients.schema";
import { users } from "./users.schema";

// ───── anamneses (append-only snapshots, BR/CFO-aware) ─────
export const anamneses = pgTable(
  "anamneses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    specialties: text("specialties")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    chiefComplaint: text("chief_complaint"),
    presentIllnessHistory: text("present_illness_history"),
    allergiesSummary: text("allergies_summary"),
    medicationsSummary: text("medications_summary"),
    underMedicalTreatment: boolean("under_medical_treatment")
      .notNull()
      .default(false),
    pregnant: boolean("pregnant"),
    gestationalWeeks: integer("gestational_weeks"),
    lactating: boolean("lactating"),
    smoker: boolean("smoker").notNull().default(false),
    alcoholUse: text("alcohol_use"),
    bruxism: boolean("bruxism").notNull().default(false),
    lastDentalVisit: date("last_dental_visit"),
    answers: jsonb("answers")
      .notNull()
      .default(sql`'{}'::jsonb`),
    consentSigned: boolean("consent_signed").notNull().default(false),
    consentSignedAt: timestamp("consent_signed_at", { withTimezone: true }),
    signatureUrl: text("signature_url"),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    byPatient: index("anamneses_patient_recorded_idx").on(
      t.patientId,
      t.recordedAt,
    ),
  }),
);
