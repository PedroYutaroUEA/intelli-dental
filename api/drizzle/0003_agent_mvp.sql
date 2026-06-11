DO $$ BEGIN
 CREATE TYPE "public"."agent_step_type" AS ENUM('intent','plan','rewrite','retrieve','evaluate','tool','generate','verify','fallback','error');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "clinic_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "question" text NOT NULL,
  "intent" text,
  "fallback_used" boolean DEFAULT false NOT NULL,
  "insufficient_evidence" boolean DEFAULT false NOT NULL,
  "total_tokens_in" integer DEFAULT 0 NOT NULL,
  "total_tokens_out" integer DEFAULT 0 NOT NULL,
  "total_latency_ms" integer DEFAULT 0 NOT NULL,
  "error" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "type" "agent_step_type" NOT NULL,
  "model" text,
  "prompt_version" text,
  "tokens_in" integer,
  "tokens_out" integer,
  "duration_ms" integer,
  "input" jsonb,
  "output" jsonb,
  "error" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tool_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "name" text NOT NULL,
  "args" jsonb,
  "mode" text NOT NULL,
  "ok" boolean NOT NULL,
  "mutated" boolean DEFAULT false NOT NULL,
  "result" jsonb,
  "error" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "agent_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "intent" text;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "verification" jsonb;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "fallback_used" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agent_runs_session_idx" ON "agent_runs" USING btree ("session_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_runs_patient_idx" ON "agent_runs" USING btree ("patient_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_steps_run_idx" ON "agent_steps" USING btree ("run_id","seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_calls_run_idx" ON "tool_calls" USING btree ("run_id");
