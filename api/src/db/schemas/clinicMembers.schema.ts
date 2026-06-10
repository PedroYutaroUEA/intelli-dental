import {
  boolean,
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { clinics } from "./clinics.schema";
import { users } from "./users.schema";

export const clinicRoleEnum = pgEnum("clinic_role", [
  "owner",
  "dentist",
  "assistant",
  "receptionist",
]);

// ───── clinic memberships (M:N user×clinic with role) ─────
export const clinicMembers = pgTable(
  "clinic_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clinicId: uuid("clinic_id")
      .notNull()
      .references(() => clinics.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: clinicRoleEnum("role").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uq: uniqueIndex("clinic_members_clinic_user_uq").on(t.clinicId, t.userId),
    byUser: index("clinic_members_user_idx").on(t.userId),
    byClinicRole: index("clinic_members_clinic_role_idx").on(
      t.clinicId,
      t.role,
    ),
  }),
);
