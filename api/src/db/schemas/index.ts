import { anamneses } from "./anemneses.schema";
import { appointments } from "./appointments.schema";
import { bookingTokens } from "./bookingTokens.schema";
import { chatMessages } from "./chatMessages.schema";
import { chatSessionMemory } from "./chatSessionMemory.schema";
import { chatSessions } from "./chatSessions.schema";
import { clinicMembers } from "./clinicMembers.schema";
import { clinics } from "./clinics.schema";
import { patientDocuments } from "./patientDocuments.schema";
import { patients } from "./patients.schema";
import { users } from "./users.schema";

import {
  agentEvaluations,
  agentRuns,
  agentSteps,
  documentVersions,
  modelConfigs,
  promptVersions,
  retrievedChunks,
  toolCalls,
  userFeedback,
} from "./agent";

export {
  agentRuns,
  agentSteps,
  agentEvaluations,
  anamneses,
  appointments,
  bookingTokens,
  chatMessages,
  chatSessionMemory,
  chatSessions,
  clinicMembers,
  clinics,
  patientDocuments,
  patients,
  documentVersions,
  modelConfigs,
  promptVersions,
  retrievedChunks,
  toolCalls,
  userFeedback,
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
type ChatSessionMemory = typeof chatSessionMemory.$inferSelect;
type BookingToken = typeof bookingTokens.$inferSelect;
type AgentRuns = typeof agentRuns.$inferSelect;
type AgentSteps = typeof agentSteps.$inferSelect;
type AgentEvaluations = typeof agentEvaluations.$inferSelect;
type ToolCalls = typeof toolCalls.$inferSelect;
type RetrievedChunks = typeof retrievedChunks.$inferSelect;
type UserFeedback = typeof userFeedback.$inferSelect;

export {
  AgentRuns,
  AgentSteps,
  AgentEvaluations,
  Anamnesis,
  Appointment,
  BookingToken,
  ChatMessage,
  ChatSessionMemory,
  ChatSession,
  Clinic,
  ClinicMember,
  Patient,
  PatientDocument,
  RetrievedChunks,
  ToolCalls,
  UserFeedback,
  User,
};
