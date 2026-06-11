import { index, integer, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentRuns } from "./agentRuns.schema";
import { agentSteps } from "./agentSteps.schema";

export const retrievedChunks = pgTable(
  "retrieved_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    stepId: uuid("step_id").references(() => agentSteps.id, { onDelete: "cascade" }),
    chunkId: text("chunk_id").notNull(),
    source: text("source").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    distance: real("distance"),
    score: real("score"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byRun: index("retrieved_chunks_run_idx").on(t.runId) }),
);
