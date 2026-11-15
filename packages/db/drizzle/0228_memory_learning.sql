CREATE TABLE "memory_candidates" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"pass_id" uuid NOT NULL,
	"ord" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '14 days' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_candidates_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "memory_candidates_pass_ord_unique" UNIQUE("team_id","pass_id","ord"),
	CONSTRAINT "memory_candidates_state" CHECK ("memory_candidates"."state" IN ('open', 'saved', 'proposed', 'suggested', 'dismissed', 'expired')),
	CONSTRAINT "memory_candidates_decided" CHECK (("memory_candidates"."state" = 'open') = ("memory_candidates"."decided_at" IS NULL)),
	CONSTRAINT "memory_candidates_ord" CHECK ("memory_candidates"."ord" >= 0),
	CONSTRAINT "memory_candidates_payload" CHECK (jsonb_typeof("memory_candidates"."payload") = 'object' AND octet_length("memory_candidates"."payload"::text) <= 32768)
);
--> statement-breakpoint
CREATE TABLE "memory_dismissals" (
	"team_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"statement_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_dismissals_team_id_thread_id_user_id_statement_hash_pk" PRIMARY KEY("team_id","thread_id","user_id","statement_hash"),
	CONSTRAINT "memory_dismissals_hash" CHECK ("memory_dismissals"."statement_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "memory_learning_passes" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"branch_leaf_entry_id" text NOT NULL,
	"from_entry_id" text,
	"to_entry_id" text,
	"model_alias" text NOT NULL,
	"prompt_version" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"usage" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_learning_passes_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "memory_learning_passes_status" CHECK ("memory_learning_passes"."status" IN ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "memory_learning_passes_finished" CHECK (("memory_learning_passes"."status" IN ('completed', 'failed')) = ("memory_learning_passes"."finished_at" IS NOT NULL)),
	CONSTRAINT "memory_learning_passes_completed" CHECK ("memory_learning_passes"."status" <> 'completed' OR "memory_learning_passes"."to_entry_id" IS NOT NULL),
	CONSTRAINT "memory_learning_passes_error" CHECK (("memory_learning_passes"."status" = 'failed') = ("memory_learning_passes"."error" IS NOT NULL) AND ("memory_learning_passes"."error" IS NULL OR char_length("memory_learning_passes"."error") BETWEEN 1 AND 2000)),
	CONSTRAINT "memory_learning_passes_labels" CHECK (char_length("memory_learning_passes"."model_alias") BETWEEN 1 AND 240 AND char_length("memory_learning_passes"."prompt_version") BETWEEN 1 AND 240),
	CONSTRAINT "memory_learning_passes_usage" CHECK ("memory_learning_passes"."usage" IS NULL OR (jsonb_typeof("memory_learning_passes"."usage") = 'object' AND octet_length("memory_learning_passes"."usage"::text) <= 4096))
);
--> statement-breakpoint
CREATE TABLE "memory_learning_watermarks" (
	"team_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"entry_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_learning_watermarks_team_id_thread_id_user_id_pk" PRIMARY KEY("team_id","thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "memory_proposals" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"candidate_ref" uuid,
	"item_ref" uuid,
	"statement" text NOT NULL,
	"kind" text NOT NULL,
	"rationale" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"proposer_id" uuid NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	"expires_at" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_proposals_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "memory_proposals_source" CHECK ("memory_proposals"."source" IN ('candidate', 'item')),
	CONSTRAINT "memory_proposals_refs" CHECK (("memory_proposals"."source" = 'candidate' AND "memory_proposals"."item_ref" IS NULL) OR ("memory_proposals"."source" = 'item' AND "memory_proposals"."candidate_ref" IS NULL)),
	CONSTRAINT "memory_proposals_state" CHECK ("memory_proposals"."state" IN ('pending', 'approved', 'rejected', 'expired')),
	CONSTRAINT "memory_proposals_kind" CHECK ("memory_proposals"."kind" IN ('preference', 'fact', 'convention', 'definition', 'decision')),
	CONSTRAINT "memory_proposals_statement" CHECK (char_length(btrim("memory_proposals"."statement")) >= 1 AND char_length("memory_proposals"."statement") <= 500),
	CONSTRAINT "memory_proposals_decided" CHECK (("memory_proposals"."state" = 'pending') = ("memory_proposals"."decided_at" IS NULL) AND ("memory_proposals"."state" IN ('approved', 'rejected')) = ("memory_proposals"."decided_by" IS NOT NULL)),
	CONSTRAINT "memory_proposals_reason" CHECK ("memory_proposals"."reason" IS NULL OR ("memory_proposals"."state" <> 'pending' AND char_length("memory_proposals"."reason") BETWEEN 1 AND 1000)),
	CONSTRAINT "memory_proposals_rationale" CHECK ("memory_proposals"."rationale" IS NULL OR char_length("memory_proposals"."rationale") BETWEEN 1 AND 1000)
);
--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_pass_fk" FOREIGN KEY ("team_id","pass_id") REFERENCES "public"."memory_learning_passes"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_dismissals" ADD CONSTRAINT "memory_dismissals_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_dismissals" ADD CONSTRAINT "memory_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_dismissals" ADD CONSTRAINT "memory_dismissals_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_learning_passes" ADD CONSTRAINT "memory_learning_passes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_learning_passes" ADD CONSTRAINT "memory_learning_passes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_learning_passes" ADD CONSTRAINT "memory_learning_passes_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_learning_passes" ADD CONSTRAINT "memory_learning_passes_leaf_fk" FOREIGN KEY ("team_id","thread_id","branch_leaf_entry_id") REFERENCES "public"."thread_entries"("team_id","thread_id","entry_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_learning_passes" ADD CONSTRAINT "memory_learning_passes_from_fk" FOREIGN KEY ("team_id","thread_id","from_entry_id") REFERENCES "public"."thread_entries"("team_id","thread_id","entry_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_learning_passes" ADD CONSTRAINT "memory_learning_passes_to_fk" FOREIGN KEY ("team_id","thread_id","to_entry_id") REFERENCES "public"."thread_entries"("team_id","thread_id","entry_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_learning_watermarks" ADD CONSTRAINT "memory_learning_watermarks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_learning_watermarks" ADD CONSTRAINT "memory_learning_watermarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_learning_watermarks" ADD CONSTRAINT "memory_learning_watermarks_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_learning_watermarks" ADD CONSTRAINT "memory_learning_watermarks_entry_fk" FOREIGN KEY ("team_id","thread_id","entry_id") REFERENCES "public"."thread_entries"("team_id","thread_id","entry_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_proposer_id_users_id_fk" FOREIGN KEY ("proposer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_proposals" ADD CONSTRAINT "memory_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_candidates_expiry_idx" ON "memory_candidates" USING btree ("team_id","expires_at") WHERE "memory_candidates"."state" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "memory_learning_passes_active_unique" ON "memory_learning_passes" USING btree ("team_id","thread_id") WHERE "memory_learning_passes"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "memory_learning_passes_thread_idx" ON "memory_learning_passes" USING btree ("team_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_learning_passes_user_idx" ON "memory_learning_passes" USING btree ("team_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_learning_passes_finished_idx" ON "memory_learning_passes" USING btree ("team_id","finished_at") WHERE "memory_learning_passes"."finished_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "memory_proposals_state_idx" ON "memory_proposals" USING btree ("team_id","state","created_at");--> statement-breakpoint
CREATE INDEX "memory_proposals_proposer_idx" ON "memory_proposals" USING btree ("team_id","proposer_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_proposals_candidate_idx" ON "memory_proposals" USING btree ("team_id","candidate_ref") WHERE "memory_proposals"."candidate_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "memory_proposals_item_idx" ON "memory_proposals" USING btree ("team_id","item_ref") WHERE "memory_proposals"."item_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "memory_proposals_expiry_idx" ON "memory_proposals" USING btree ("team_id","expires_at") WHERE "memory_proposals"."state" = 'pending';