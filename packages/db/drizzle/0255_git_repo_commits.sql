CREATE TABLE "git_commit_branches" (
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"base_commit_id" uuid NOT NULL,
	"base_sha" text NOT NULL,
	"branch" text NOT NULL,
	"head_sha" text NOT NULL,
	"tree_sha" text NOT NULL,
	"pull_number" integer NOT NULL,
	"pull_url" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_commit_branches_team_id_project_id_user_id_pk" PRIMARY KEY("team_id","project_id","user_id"),
	CONSTRAINT "git_commit_branches_shas" CHECK ("git_commit_branches"."base_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' AND "git_commit_branches"."head_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' AND "git_commit_branches"."tree_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "git_commit_branches_branch" CHECK ("git_commit_branches"."branch" ~ '^[^[:space:]:~^?*\[\\]{1,255}$' AND "git_commit_branches"."branch" NOT LIKE '%..%'),
	CONSTRAINT "git_commit_branches_pull" CHECK ("git_commit_branches"."pull_number" > 0),
	CONSTRAINT "git_commit_branches_pull_url" CHECK ("git_commit_branches"."pull_url" = '' OR ("git_commit_branches"."pull_url" ~ '^https?://' AND char_length("git_commit_branches"."pull_url") <= 2048))
);
--> statement-breakpoint
CREATE TABLE "git_working_copies" (
	"team_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"branch" text,
	"head_sha" text,
	"upstream" text,
	"ahead" integer DEFAULT 0 NOT NULL,
	"behind" integer DEFAULT 0 NOT NULL,
	"dirty" boolean DEFAULT false NOT NULL,
	"fetched" boolean DEFAULT true NOT NULL,
	"problem" text,
	"run_id" uuid,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_working_copies_team_id_project_id_user_id_pk" PRIMARY KEY("team_id","project_id","user_id"),
	CONSTRAINT "git_working_copies_branch" CHECK (("git_working_copies"."branch" IS NULL OR "git_working_copies"."branch" ~ '^[^[:space:]:~^?*\[\\]{1,255}$') AND ("git_working_copies"."upstream" IS NULL OR "git_working_copies"."upstream" ~ '^[^[:space:]:~^?*\[\\]{1,255}$')),
	CONSTRAINT "git_working_copies_head" CHECK ("git_working_copies"."head_sha" IS NULL OR "git_working_copies"."head_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "git_working_copies_counts" CHECK ("git_working_copies"."ahead" BETWEEN 0 AND 10000 AND "git_working_copies"."behind" BETWEEN 0 AND 10000),
	CONSTRAINT "git_working_copies_problem" CHECK ("git_working_copies"."problem" IS NULL OR char_length("git_working_copies"."problem") <= 200)
);
--> statement-breakpoint
ALTER TABLE "git_commit_branches" ADD CONSTRAINT "git_commit_branches_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_commit_branches" ADD CONSTRAINT "git_commit_branches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_commit_branches" ADD CONSTRAINT "git_commit_branches_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_commit_branches" ADD CONSTRAINT "git_commit_branches_repository_fk" FOREIGN KEY ("team_id","repository_id") REFERENCES "public"."git_repositories"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_working_copies" ADD CONSTRAINT "git_working_copies_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_working_copies" ADD CONSTRAINT "git_working_copies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_working_copies" ADD CONSTRAINT "git_working_copies_project_fk" FOREIGN KEY ("team_id","project_id") REFERENCES "public"."projects"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "git_commit_branches_user_idx" ON "git_commit_branches" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "git_commit_branches_repository_idx" ON "git_commit_branches" USING btree ("team_id","repository_id");--> statement-breakpoint
CREATE INDEX "git_working_copies_user_idx" ON "git_working_copies" USING btree ("user_id");