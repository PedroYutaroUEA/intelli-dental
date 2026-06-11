import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const promptVersions = pgTable("prompt_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  module: text("module").notNull(),
  version: text("version").notNull(),
  hash: text("hash").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
