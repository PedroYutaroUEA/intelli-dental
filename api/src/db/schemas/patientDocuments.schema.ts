import {
  bigint,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.schema";
import { patients } from "./patients.schema";
import { users } from "./users.schema";

export const ingestStatusEnum = pgEnum("ingest_status", [
  "pending",
  "processing",
  "ready",
  "failed",
]);

// ───── patient documents (RAG sources) ─────
export const patientDocuments = pgTable(
  "patient_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storageUrl: text("storage_url").notNull(),
    ingestStatus: ingestStatusEnum("ingest_status")
      .notNull()
      .default("pending"),
    ingestError: text("ingest_error"),
    chunkCount: integer("chunk_count"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    byPatientStatus: index("patient_documents_patient_status_idx").on(
      t.patientId,
      t.ingestStatus,
    ),
  }),
);
