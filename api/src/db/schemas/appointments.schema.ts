import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.schema";
import { patients } from "./patients.schema";
import { users } from "./users.schema";

export const appointmentStatusEnum = pgEnum("appointment_status", [
  "requested",
  "scheduled",
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
]);

// ───── appointments ─────
export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id),
    dentistId: uuid("dentist_id")
      .notNull()
      .references(() => users.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: appointmentStatusEnum("status").notNull().default("scheduled"),
    reason: text("reason"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    rangeChk: check("appointments_range_chk", sql`${t.endsAt} > ${t.startsAt}`),
    byClinicStart: index("appointments_clinic_start_idx").on(
      t.clinicId,
      t.startsAt,
    ),
    byDentistStart: index("appointments_dentist_start_idx").on(
      t.dentistId,
      t.startsAt,
    ),
    byPatientStart: index("appointments_patient_start_idx").on(
      t.patientId,
      t.startsAt,
    ),
  }),
);
