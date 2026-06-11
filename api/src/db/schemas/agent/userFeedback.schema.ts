import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "..";
import { agentRuns } from "./agentRuns.schema";

export const userFeedback = pgTable("user_feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  rating: integer("rating").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
