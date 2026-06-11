import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { chatSessions } from "./chatSessions.schema";
import { agentRuns } from "./agent/agentRuns.schema";

export const chatRoleEnum = pgEnum("chat_role", [
  "user",
  "assistant",
  "system",
]);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: chatRoleEnum("role").notNull(),
    content: text("content").notNull(),
    sources: jsonb("sources"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    contextRelevance: real("context_relevance"),
    groundedness: real("groundedness"),
    answerRelevance: real("answer_relevance"),
    metricsPerChunk: jsonb("metrics_per_chunk"),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    intent: text("intent"),
    verification: jsonb("verification"),
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    bySession: index("chat_messages_session_idx").on(t.sessionId, t.createdAt),
  }),
);
