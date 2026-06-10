import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clinics } from "./clinics.schema";
import { patients } from "./patients.schema";
import { users } from "./users.schema";

// ───── chat sessions + messages ─────
export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    byPatient: index("chat_sessions_patient_idx").on(t.patientId, t.updatedAt),
    byUser: index("chat_sessions_user_idx").on(t.userId, t.updatedAt),
  }),
);
