CREATE TABLE "memory_project_suggestions" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"candidate_ref" uuid,
	"statement" text NOT NULL,
	"kind" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"suggested_by" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	"expires_at" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_project_suggestions_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "memory_project_suggestions_state" CHECK ("memory_project_suggestions"."state" IN ('pending', 'approved', 'dismissed', 'expired')),
	CONSTRAINT "memory_project_suggestions_kind" CHECK ("memory_project_suggestions"."kind" IN ('preference', 'fact', 'convention', 'definition', 'decision')),
	CONSTRAINT "memory_project_suggestions_statement" CHECK (char_length(btrim("memory_project_suggestions"."statement")) >= 1 AND char_length("memory_project_suggestions"."statement") <= 500),
	CONSTRAINT "memory_project_suggestions_evidence" CHECK (jsonb_typeof("memory_project_suggestions"."evidence") = 'array' AND jsonb_array_length("memory_project_suggestions"."evidence") BETWEEN 1 AND 20 AND octet_length("memory_project_suggestions"."evidence"::text) <= 16384),
	CONSTRAINT "memory_project_suggestions_decided" CHECK (("memory_project_suggestions"."state" = 'pending') = ("memory_project_suggestions"."decided_at" IS NULL) AND ("memory_project_suggestions"."state" IN ('approved', 'dismissed')) = ("memory_project_suggestions"."decided_by" IS NOT NULL)),
	CONSTRAINT "memory_project_suggestions_reason" CHECK ("memory_project_suggestions"."reason" IS NULL OR ("memory_project_suggestions"."state" = 'dismissed' AND char_length(btrim("memory_project_suggestions"."reason")) >= 1 AND char_length("memory_project_suggestions"."reason") <= 1000))
);
--> statement-breakpoint
ALTER TABLE "memory_project_suggestions" ADD CONSTRAINT "memory_project_suggestions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_project_suggestions" ADD CONSTRAINT "memory_project_suggestions_suggested_by_users_id_fk" FOREIGN KEY ("suggested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_project_suggestions" ADD CONSTRAINT "memory_project_suggestions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_project_suggestions" ADD CONSTRAINT "memory_project_suggestions_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_project_suggestions" ADD CONSTRAINT "memory_project_suggestions_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_project_suggestions_queue_idx" ON "memory_project_suggestions" USING btree ("team_id","project_id","state","created_at");--> statement-breakpoint
CREATE INDEX "memory_project_suggestions_thread_idx" ON "memory_project_suggestions" USING btree ("team_id","thread_id");--> statement-breakpoint
CREATE INDEX "memory_project_suggestions_suggester_idx" ON "memory_project_suggestions" USING btree ("team_id","suggested_by","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_project_suggestions_candidate_unique" ON "memory_project_suggestions" USING btree ("team_id","candidate_ref") WHERE "memory_project_suggestions"."candidate_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "memory_project_suggestions_expiry_idx" ON "memory_project_suggestions" USING btree ("team_id","expires_at") WHERE "memory_project_suggestions"."state" = 'pending';