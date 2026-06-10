import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.schema";
import { patients } from "./patients.schema";
import { users } from "./users.schema";

// ───── booking tokens (patient self-booking links) ─────
export const bookingTokens = pgTable(
  "booking_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    hashUq: uniqueIndex("booking_tokens_hash_uq").on(t.tokenHash),
    byPatient: index("booking_tokens_patient_idx").on(t.patientId),
    byClinic: index("booking_tokens_clinic_idx").on(t.clinicId),
  }),
);
