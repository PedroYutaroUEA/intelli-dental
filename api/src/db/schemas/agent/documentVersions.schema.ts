import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { patients } from "..";

export const documentVersions = pgTable(
  "document_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id").notNull().references(() => patients.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    version: integer("version").notNull(),
    corpusVersion: integer("corpus_version").notNull(),
    chunkCount: integer("chunk_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ byPatient: index("document_versions_patient_idx").on(t.patientId, t.version) }),
);
