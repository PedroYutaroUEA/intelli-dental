import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agentRuns.schema";

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    args: jsonb("args"), // redacted/whitelisted keys only
    mode: text("mode").notNull(), // 'preview' | 'commit'
    ok: boolean("ok").notNull(),
    mutated: boolean("mutated").notNull().default(false),
    result: jsonb("result"),
    error: jsonb("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({ byRun: index("tool_calls_run_idx").on(t.runId) }),
);
