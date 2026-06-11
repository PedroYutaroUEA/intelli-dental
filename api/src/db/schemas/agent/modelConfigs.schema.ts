import { boolean, integer, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const modelConfigs = pgTable("model_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  task: text("task").notNull(),
  model: text("model").notNull(),
  temperature: real("temperature"),
  maxTokens: integer("max_tokens"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
