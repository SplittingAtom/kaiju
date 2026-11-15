CREATE TABLE "site_break_glass_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_user_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"approver_id" uuid,
	"reason" text NOT NULL,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"status" "break_glass_status" DEFAULT 'pending' NOT NULL,
	"self_approved" boolean DEFAULT false NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_expires_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "site_break_glass_grants_reason" CHECK (char_length(btrim("site_break_glass_grants"."reason")) BETWEEN 1 AND 2000),
	CONSTRAINT "site_break_glass_grants_duration" CHECK ("site_break_glass_grants"."duration_minutes" BETWEEN 1 AND 1440),
	CONSTRAINT "site_break_glass_grants_subject_not_requester" CHECK ("site_break_glass_grants"."subject_user_id" <> "site_break_glass_grants"."admin_id"),
	CONSTRAINT "site_break_glass_grants_subject_not_approver" CHECK ("site_break_glass_grants"."approver_id" IS DISTINCT FROM "site_break_glass_grants"."subject_user_id"),
	CONSTRAINT "site_break_glass_grants_two_person" CHECK ("site_break_glass_grants"."approver_id" IS NULL OR ("site_break_glass_grants"."approver_id" = "site_break_glass_grants"."admin_id") = "site_break_glass_grants"."self_approved"),
	CONSTRAINT "site_break_glass_grants_window" CHECK (("site_break_glass_grants"."starts_at" IS NULL) = ("site_break_glass_grants"."expires_at" IS NULL) AND ("site_break_glass_grants"."starts_at" IS NULL OR ("site_break_glass_grants"."expires_at" > "site_break_glass_grants"."starts_at" AND "site_break_glass_grants"."expires_at" <= "site_break_glass_grants"."starts_at" + interval '24 hours'))),
	CONSTRAINT "site_break_glass_grants_approved_shape" CHECK ("site_break_glass_grants"."status" <> 'approved' OR ("site_break_glass_grants"."approver_id" IS NOT NULL AND "site_break_glass_grants"."starts_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "site_break_glass_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"event" text NOT NULL,
	"was_active" boolean DEFAULT false NOT NULL,
	"recipient_id" uuid NOT NULL,
	"recipient_role" text NOT NULL,
	"status" "break_glass_notification_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "site_break_glass_notifications_event" CHECK ("site_break_glass_notifications"."event" IN ('requested', 'approved', 'denied', 'revoked', 'expired')),
	CONSTRAINT "site_break_glass_notifications_role" CHECK ("site_break_glass_notifications"."recipient_role" IN ('site_admin', 'team_admin', 'subject', 'requester')),
	CONSTRAINT "site_break_glass_notifications_last_error" CHECK (char_length("site_break_glass_notifications"."last_error") <= 64)
);
--> statement-breakpoint
ALTER TABLE "site_break_glass_grants" ADD CONSTRAINT "site_break_glass_grants_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_break_glass_grants" ADD CONSTRAINT "site_break_glass_grants_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_break_glass_grants" ADD CONSTRAINT "site_break_glass_grants_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_break_glass_grants" ADD CONSTRAINT "site_break_glass_grants_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_break_glass_notifications" ADD CONSTRAINT "site_break_glass_notifications_grant_id_site_break_glass_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."site_break_glass_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_break_glass_notifications" ADD CONSTRAINT "site_break_glass_notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_break_glass_grants_subject_idx" ON "site_break_glass_grants" USING btree ("subject_user_id","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "site_break_glass_grants_status_idx" ON "site_break_glass_grants" USING btree ("status","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "site_break_glass_grants_open_idx" ON "site_break_glass_grants" USING btree ("expires_at","request_expires_at") WHERE "site_break_glass_grants"."status" IN ('pending', 'approved');--> statement-breakpoint
CREATE INDEX "site_break_glass_notifications_due_idx" ON "site_break_glass_notifications" USING btree ("next_attempt_at") WHERE "site_break_glass_notifications"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "site_break_glass_notifications_grant_idx" ON "site_break_glass_notifications" USING btree ("grant_id");