import { boolean, index, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentRuns } from "./agentRuns.schema";

export const agentEvaluations = pgTable(
  "agent_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    sufficient: boolean("sufficient"),
    faithful: boolean("faithful"),
    score: real("score"),
    groundedness: real("groundedness"),
    citationsOk: boolean("citations_ok"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byRun: index("agent_evaluations_run_idx").on(t.runId) }),
);
