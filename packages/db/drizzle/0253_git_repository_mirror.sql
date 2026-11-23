CREATE TABLE "git_repository_commits" (
	"team_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"sha" text NOT NULL,
	"author_name" text NOT NULL,
	"authored_at" timestamp with time zone NOT NULL,
	"message" text NOT NULL,
	CONSTRAINT "git_repository_commits_team_id_repository_id_position_pk" PRIMARY KEY("team_id","repository_id","position"),
	CONSTRAINT "git_repository_commits_position" CHECK ("git_repository_commits"."position" >= 0 AND "git_repository_commits"."position" < 25),
	CONSTRAINT "git_repository_commits_sha" CHECK ("git_repository_commits"."sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "git_repository_commits_author" CHECK (char_length("git_repository_commits"."author_name") <= 200),
	CONSTRAINT "git_repository_commits_message" CHECK (char_length("git_repository_commits"."message") <= 500)
);
--> statement-breakpoint
ALTER TABLE "git_repositories" ADD COLUMN "mirror_commit_id" uuid;--> statement-breakpoint
ALTER TABLE "git_repositories" ADD COLUMN "mirror_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "git_repositories" ADD COLUMN "mirror_error" text;--> statement-breakpoint
ALTER TABLE "git_repositories" ADD COLUMN "mirror_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "git_repositories" ADD COLUMN "mirror_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "git_repositories" ADD COLUMN "mirror_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "git_repositories" ADD COLUMN "mirror_lease_owner" uuid;--> statement-breakpoint
ALTER TABLE "git_repositories" ADD COLUMN "mirror_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "git_repository_commits" ADD CONSTRAINT "git_repository_commits_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_repository_commits" ADD CONSTRAINT "git_repository_commits_repository_fk" FOREIGN KEY ("team_id","repository_id") REFERENCES "public"."git_repositories"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_repositories" ADD CONSTRAINT "git_repositories_mirror_error" CHECK ("git_repositories"."mirror_error" IS NULL OR char_length("git_repositories"."mirror_error") <= 64);--> statement-breakpoint
ALTER TABLE "git_repositories" ADD CONSTRAINT "git_repositories_mirror_failures" CHECK ("git_repositories"."mirror_failures" >= 0);