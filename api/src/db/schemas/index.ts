import { anamneses } from "./anemneses.schema";
import { appointments } from "./appointments.schema";
import { bookingTokens } from "./bookingTokens.schema";
import { chatMessages } from "./chatMessages.schema";
import { chatSessions } from "./chatSessions.schema";
import { clinicMembers } from "./clinicMembers.schema";
import { clinics } from "./clinics.schema";
import { patientDocuments } from "./patientDocuments.schema";
import { patients } from "./patients.schema";
import { users } from "./users.schema";

import { agentRuns, agentSteps, toolCalls } from "./agent";

export {
  agentRuns,
  agentSteps,
  anamneses,
  appointments,
  bookingTokens,
  chatMessages,
  chatSessions,
  clinicMembers,
  clinics,
  patientDocuments,
  patients,
  toolCalls,
  users,
};

// ───── inferred types (handy in services) ─────
type User = typeof users.$inferSelect;
type Clinic = typeof clinics.$inferSelect;
type ClinicMember = typeof clinicMembers.$inferSelect;
type Patient = typeof patients.$inferSelect;
type Appointment = typeof appointments.$inferSelect;
type Anamnesis = typeof anamneses.$inferSelect;
type PatientDocument = typeof patientDocuments.$inferSelect;
type ChatSession = typeof chatSessions.$inferSelect;
type ChatMessage = typeof chatMessages.$inferSelect;
type BookingToken = typeof bookingTokens.$inferSelect;
type AgentRuns = typeof agentRuns.$inferSelect;
type AgentSteps = typeof agentSteps.$inferSelect;
type ToolCalls = typeof toolCalls.$inferSelect;

export {
  AgentRuns,
  AgentSteps,
  Anamnesis,
  Appointment,
  BookingToken,
  ChatMessage,
  ChatSession,
  Clinic,
  ClinicMember,
  Patient,
  PatientDocument,
  ToolCalls,
  User,
};
