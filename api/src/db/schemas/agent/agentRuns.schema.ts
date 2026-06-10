import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { chatSessions, clinics, patients, users } from "..";

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    question: text("question").notNull(),
    intent: text("intent"),
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    insufficientEvidence: boolean("insufficient_evidence")
      .notNull()
      .default(false),
    totalTokensIn: integer("total_tokens_in").notNull().default(0),
    totalTokensOut: integer("total_tokens_out").notNull().default(0),
    totalLatencyMs: integer("total_latency_ms").notNull().default(0),
    error: jsonb("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    bySession: index("agent_runs_session_idx").on(t.sessionId, t.createdAt),
    byPatient: index("agent_runs_patient_idx").on(t.patientId, t.createdAt),
  }),
);
