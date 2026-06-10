import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agentRuns.schema";

export const agentStepTypeEnum = pgEnum("agent_step_type", [
  "intent",
  "plan",
  "rewrite",
  "retrieve",
  "evaluate",
  "tool",
  "generate",
  "verify",
  "fallback",
  "error",
]);

export const agentSteps = pgTable(
  "agent_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: agentStepTypeEnum("type").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    durationMs: integer("duration_ms"),
    input: jsonb("input"), // redacted at low log levels
    output: jsonb("output"), // redacted at low log levels
    error: jsonb("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({ byRun: index("agent_steps_run_idx").on(t.runId, t.seq) }),
);
