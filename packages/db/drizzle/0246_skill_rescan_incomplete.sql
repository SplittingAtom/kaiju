ALTER TABLE "personal_skill_scans" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "personal_skill_scans" ADD COLUMN "rescan_incomplete_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "personal_skill_scans" ADD COLUMN "rescan_incomplete_rule_set" integer;--> statement-breakpoint
ALTER TABLE "team_skill_reviews" ADD COLUMN "suspended_reason" text;--> statement-breakpoint
ALTER TABLE "team_skill_reviews" ADD COLUMN "rescan_incomplete_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_skill_reviews" ADD COLUMN "rescan_incomplete_rule_set" integer;--> statement-breakpoint
ALTER TABLE "personal_skill_scans" ADD CONSTRAINT "personal_skill_scans_suspended_reason" CHECK ("personal_skill_scans"."suspended_reason" IS NULL OR "personal_skill_scans"."suspended_reason" IN ('rescan_block', 'rescan_incomplete'));--> statement-breakpoint
ALTER TABLE "personal_skill_scans" ADD CONSTRAINT "personal_skill_scans_rescan_incomplete" CHECK (("personal_skill_scans"."rescan_incomplete_since" IS NULL) = ("personal_skill_scans"."rescan_incomplete_rule_set" IS NULL));--> statement-breakpoint
ALTER TABLE "team_skill_reviews" ADD CONSTRAINT "team_skill_reviews_suspended_reason" CHECK ("team_skill_reviews"."suspended_reason" IS NULL OR "team_skill_reviews"."suspended_reason" IN ('rescan_block', 'rescan_incomplete'));--> statement-breakpoint
ALTER TABLE "team_skill_reviews" ADD CONSTRAINT "team_skill_reviews_rescan_incomplete" CHECK (("team_skill_reviews"."rescan_incomplete_since" IS NULL) = ("team_skill_reviews"."rescan_incomplete_rule_set" IS NULL));