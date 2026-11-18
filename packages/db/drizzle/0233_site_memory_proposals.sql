CREATE TABLE "site_memory_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_team_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"kind" text NOT NULL,
	"justification" text NOT NULL,
	"endorsed" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'awaiting_team' NOT NULL,
	"rounds" integer DEFAULT 0 NOT NULL,
	"proposer_id" uuid NOT NULL,
	"team_confirmed_by" uuid,
	"team_confirmed_at" timestamp with time zone,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	"merged_into" uuid,
	"expires_at" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_memory_proposals_state" CHECK ("site_memory_proposals"."state" IN ('awaiting_team', 'awaiting_site', 'changes_requested', 'approved', 'merged', 'rejected', 'expired', 'withdrawn')),
	CONSTRAINT "site_memory_proposals_rounds" CHECK ("site_memory_proposals"."rounds" BETWEEN 0 AND 3),
	CONSTRAINT "site_memory_proposals_kind" CHECK ("site_memory_proposals"."kind" IN ('preference', 'fact', 'convention', 'definition', 'decision')),
	CONSTRAINT "site_memory_proposals_statement" CHECK (char_length(btrim("site_memory_proposals"."statement")) >= 1 AND char_length("site_memory_proposals"."statement") <= 500),
	CONSTRAINT "site_memory_proposals_justification" CHECK (char_length(btrim("site_memory_proposals"."justification")) >= 1 AND char_length("site_memory_proposals"."justification") <= 1000),
	CONSTRAINT "site_memory_proposals_reason" CHECK ("site_memory_proposals"."reason" IS NULL OR (char_length(btrim("site_memory_proposals"."reason")) >= 1 AND char_length("site_memory_proposals"."reason") <= 1000)),
	CONSTRAINT "site_memory_proposals_team_confirmed" CHECK ("site_memory_proposals"."state" NOT IN ('awaiting_site', 'approved', 'merged') OR "site_memory_proposals"."team_confirmed_by" IS NOT NULL),
	CONSTRAINT "site_memory_proposals_decided" CHECK ("site_memory_proposals"."state" NOT IN ('changes_requested', 'approved', 'merged', 'rejected') OR ("site_memory_proposals"."decided_by" IS NOT NULL AND "site_memory_proposals"."decided_at" IS NOT NULL)),
	CONSTRAINT "site_memory_proposals_merged" CHECK ("site_memory_proposals"."merged_into" IS NULL OR "site_memory_proposals"."state" = 'merged')
);
--> statement-breakpoint
ALTER TABLE "site_memory_proposals" ADD CONSTRAINT "site_memory_proposals_from_team_id_teams_id_fk" FOREIGN KEY ("from_team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_memory_proposals" ADD CONSTRAINT "site_memory_proposals_proposer_id_users_id_fk" FOREIGN KEY ("proposer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_memory_proposals" ADD CONSTRAINT "site_memory_proposals_team_confirmed_by_users_id_fk" FOREIGN KEY ("team_confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_memory_proposals" ADD CONSTRAINT "site_memory_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_memory_proposals" ADD CONSTRAINT "site_memory_proposals_merged_into_site_memory_items_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."site_memory_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_memory_proposals_queue_idx" ON "site_memory_proposals" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "site_memory_proposals_team_idx" ON "site_memory_proposals" USING btree ("from_team_id","state","created_at");--> statement-breakpoint
CREATE INDEX "site_memory_proposals_proposer_idx" ON "site_memory_proposals" USING btree ("proposer_id","created_at");--> statement-breakpoint
CREATE INDEX "site_memory_proposals_expiry_idx" ON "site_memory_proposals" USING btree ("expires_at") WHERE "site_memory_proposals"."state" IN ('awaiting_team', 'awaiting_site', 'changes_requested');--> statement-breakpoint
CREATE INDEX "site_memory_proposals_merged_idx" ON "site_memory_proposals" USING btree ("merged_into") WHERE "site_memory_proposals"."merged_into" IS NOT NULL;