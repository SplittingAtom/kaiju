CREATE TABLE "git_conversions" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"connection_id" uuid,
	"requested_by" uuid NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"organization" text NOT NULL,
	"repository_name" text NOT NULL,
	"visibility" text NOT NULL,
	"carry_history" boolean NOT NULL,
	"use_existing" boolean DEFAULT false NOT NULL,
	"default_branch" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"step" text DEFAULT 'create' NOT NULL,
	"create_attempted_at" timestamp with time zone,
	"host_repo_id" text,
	"repository_id" uuid,
	"plan" jsonb,
	"commits_total" integer,
	"commits_pushed" integer DEFAULT 0 NOT NULL,
	"head_sha" text,
	"last_error" text,
	"last_error_detail" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"progress_at" timestamp with time zone,
	"resumes" integer DEFAULT 0 NOT NULL,
	"stalls" integer DEFAULT 0 NOT NULL,
	"finished_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "git_conversions_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "git_conversions_provider" CHECK ("git_conversions"."provider" IN ('github', 'gitea', 'forgejo')),
	CONSTRAINT "git_conversions_base_url" CHECK ("git_conversions"."base_url" ~ '^https://' AND char_length("git_conversions"."base_url") <= 2048),
	CONSTRAINT "git_conversions_organization" CHECK (char_length("git_conversions"."organization") BETWEEN 1 AND 100),
	CONSTRAINT "git_conversions_repository_name" CHECK ("git_conversions"."repository_name" ~ '^[A-Za-z0-9._-]{1,100}$' AND "git_conversions"."repository_name" NOT IN ('.', '..') AND "git_conversions"."repository_name" !~ '\.git$'),
	CONSTRAINT "git_conversions_visibility" CHECK ("git_conversions"."visibility" IN ('private', 'internal')),
	CONSTRAINT "git_conversions_default_branch" CHECK (char_length("git_conversions"."default_branch") BETWEEN 1 AND 100),
	CONSTRAINT "git_conversions_status" CHECK ("git_conversions"."status" IN ('running', 'failed', 'completed', 'abandoned')),
	CONSTRAINT "git_conversions_step" CHECK ("git_conversions"."step" IN ('create', 'push', 'finish', 'done')),
	CONSTRAINT "git_conversions_host_repo_id" CHECK ("git_conversions"."host_repo_id" IS NULL OR (char_length("git_conversions"."host_repo_id") BETWEEN 1 AND 64 AND "git_conversions"."host_repo_id" ~ '^[A-Za-z0-9_=-]+$')),
	CONSTRAINT "git_conversions_head_sha" CHECK ("git_conversions"."head_sha" IS NULL OR "git_conversions"."head_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "git_conversions_counts" CHECK ("git_conversions"."attempts" >= 0 AND "git_conversions"."resumes" >= 0 AND "git_conversions"."stalls" >= 0 AND "git_conversions"."commits_pushed" >= 0 AND ("git_conversions"."commits_total" IS NULL OR "git_conversions"."commits_pushed" <= "git_conversions"."commits_total")),
	CONSTRAINT "git_conversions_error" CHECK (("git_conversions"."last_error" IS NULL OR "git_conversions"."last_error" ~ '^[a-z0-9_]{1,64}$') AND ("git_conversions"."last_error_detail" IS NULL OR char_length("git_conversions"."last_error_detail") <= 1100)),
	CONSTRAINT "git_conversions_plan" CHECK ("git_conversions"."plan" IS NULL OR jsonb_typeof("git_conversions"."plan") = 'object'),
	CONSTRAINT "git_conversions_finished" CHECK (("git_conversions"."status" IN ('completed', 'abandoned')) = ("git_conversions"."finished_at" IS NOT NULL)
        AND ("git_conversions"."status" <> 'completed' OR ("git_conversions"."step" = 'done' AND "git_conversions"."host_repo_id" IS NOT NULL)))
);
--> statement-breakpoint
ALTER TABLE "git_conversions" ADD CONSTRAINT "git_conversions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_conversions" ADD CONSTRAINT "git_conversions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_conversions" ADD CONSTRAINT "git_conversions_finished_by_users_id_fk" FOREIGN KEY ("finished_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_conversions" ADD CONSTRAINT "git_conversions_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_conversions_active_unique" ON "git_conversions" USING btree ("team_id","project_id") WHERE "git_conversions"."status" IN ('running', 'failed');--> statement-breakpoint
CREATE INDEX "git_conversions_project_idx" ON "git_conversions" USING btree ("team_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "git_conversions_running_idx" ON "git_conversions" USING btree ("team_id","lease_until") WHERE "git_conversions"."status" = 'running';--> statement-breakpoint
CREATE INDEX "git_conversions_connection_idx" ON "git_conversions" USING btree ("team_id","connection_id");--> statement-breakpoint
CREATE INDEX "git_conversions_repository_idx" ON "git_conversions" USING btree ("team_id","repository_id");--> statement-breakpoint
CREATE INDEX "git_conversions_requested_by_idx" ON "git_conversions" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "git_conversions_finished_by_idx" ON "git_conversions" USING btree ("finished_by");