import { sql } from "drizzle-orm";
import {
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.schema";

// ───── patients ─────
export const patients = pgTable(
  "patients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id),
    fullName: text("full_name").notNull(),
    birthDate: date("birth_date"),
    gender: text("gender"),
    cpf: text("cpf"),
    email: text("email"),
    phone: text("phone"),
    address: text("address"),
    notes: text("notes"),
    specialties: text("specialties")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    cpfUq: uniqueIndex("patients_clinic_cpf_uq")
      .on(t.clinicId, t.cpf)
      .where(sql`${t.cpf} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    byName: index("patients_clinic_name_idx").on(t.clinicId, t.fullName),
  }),
);
