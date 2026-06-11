import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { clinics } from "./clinics.schema";
import { patients } from "./patients.schema";
import { chatMessages } from "./chatMessages.schema";
import { chatSessions } from "./chatSessions.schema";

export const chatSessionMemory = pgTable(
  "chat_session_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
    clinicId: uuid("clinic_id").notNull().references(() => clinics.id),
    patientId: uuid("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    factsJson: jsonb("facts_json"),
    sourceMessageId: uuid("source_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    bySession: index("chat_session_memory_session_idx").on(t.sessionId),
    byPatient: index("chat_session_memory_patient_idx").on(t.patientId, t.updatedAt),
  }),
);
