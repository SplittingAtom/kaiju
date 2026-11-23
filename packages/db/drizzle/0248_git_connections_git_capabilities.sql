CREATE TABLE "git_connections" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"organization" text NOT NULL,
	"display_name" text NOT NULL,
	"credential_kind" text NOT NULL,
	"credential_sealed" text NOT NULL,
	"credential_key_id" text NOT NULL,
	"credential_hint" text,
	"github_app_id" bigint,
	"github_installation_id" bigint,
	"access_level" text DEFAULT 'read' NOT NULL,
	"repo_visibility" text DEFAULT 'private' NOT NULL,
	"repo_name_prefix" text DEFAULT '' NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"push_limit_bytes" bigint DEFAULT 1073741824 NOT NULL,
	"direct_commits" boolean DEFAULT false NOT NULL,
	"agent_ids" uuid[],
	"capabilities" jsonb DEFAULT '{"create":"unknown","read":"unknown","write":"unknown","admin":"unknown"}'::jsonb NOT NULL,
	"excess_permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"credential_expires_at" timestamp with time zone,
	"expiry_notified_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"credential_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_connections_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "git_connections_provider" CHECK ("git_connections"."provider" IN ('github', 'gitea', 'forgejo')),
	CONSTRAINT "git_connections_base_url" CHECK (char_length("git_connections"."base_url") <= 2048 AND "git_connections"."base_url" ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[^?#[:space:]]*[^/?#[:space:]])?$'),
	CONSTRAINT "git_connections_organization" CHECK (char_length("git_connections"."organization") <= 100 AND "git_connections"."organization" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
	CONSTRAINT "git_connections_display_name" CHECK (char_length(btrim("git_connections"."display_name")) BETWEEN 1 AND 100),
	CONSTRAINT "git_connections_credential_kind" CHECK ("git_connections"."credential_kind" IN ('github_app', 'access_token')),
	CONSTRAINT "git_connections_credential_shape" CHECK (("git_connections"."credential_kind" = 'github_app' AND "git_connections"."provider" = 'github' AND coalesce("git_connections"."github_app_id", 0) > 0 AND coalesce("git_connections"."github_installation_id", 0) > 0 AND "git_connections"."credential_hint" IS NULL)
        OR ("git_connections"."credential_kind" = 'access_token' AND "git_connections"."github_app_id" IS NULL AND "git_connections"."github_installation_id" IS NULL)),
	CONSTRAINT "git_connections_credential_sealed" CHECK ("git_connections"."credential_sealed" ~ '^e1\.[A-Za-z0-9_.-]+$' AND char_length("git_connections"."credential_sealed") <= 16384),
	CONSTRAINT "git_connections_credential_key_id" CHECK (char_length("git_connections"."credential_key_id") BETWEEN 1 AND 64 AND "git_connections"."credential_key_id" = split_part("git_connections"."credential_sealed", '.', 2)),
	CONSTRAINT "git_connections_credential_hint" CHECK ("git_connections"."credential_hint" IS NULL OR char_length("git_connections"."credential_hint") <= 16),
	CONSTRAINT "git_connections_access_level" CHECK ("git_connections"."access_level" IN ('off', 'read', 'read_write')),
	CONSTRAINT "git_connections_repo_visibility" CHECK ("git_connections"."repo_visibility" IN ('private', 'internal')),
	CONSTRAINT "git_connections_repo_name_prefix" CHECK (char_length("git_connections"."repo_name_prefix") <= 40 AND "git_connections"."repo_name_prefix" ~ '^[A-Za-z0-9._-]*$'),
	CONSTRAINT "git_connections_default_branch" CHECK (char_length("git_connections"."default_branch") <= 100 AND "git_connections"."default_branch" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$' AND "git_connections"."default_branch" !~ '(\.\.|//|/$|\.lock$|\.$)'),
	CONSTRAINT "git_connections_push_limit" CHECK ("git_connections"."push_limit_bytes" BETWEEN 1 AND 10737418240),
	CONSTRAINT "git_connections_agent_ids" CHECK ("git_connections"."agent_ids" IS NULL OR (array_ndims("git_connections"."agent_ids") = 1 AND cardinality("git_connections"."agent_ids") BETWEEN 1 AND 50 AND array_position("git_connections"."agent_ids", NULL) IS NULL)),
	CONSTRAINT "git_connections_capabilities" CHECK (jsonb_typeof("git_connections"."capabilities") = 'object' AND "git_connections"."capabilities" - ARRAY['create', 'read', 'write', 'admin'] = '{}'::jsonb AND coalesce("capabilities" ->> 'create', '') IN ('yes', 'no', 'unknown') AND coalesce("capabilities" ->> 'read', '') IN ('yes', 'no', 'unknown') AND coalesce("capabilities" ->> 'write', '') IN ('yes', 'no', 'unknown') AND coalesce("capabilities" ->> 'admin', '') IN ('yes', 'no', 'unknown')),
	CONSTRAINT "git_connections_excess_permissions" CHECK (array_ndims("git_connections"."excess_permissions") IS DISTINCT FROM 2 AND cardinality("git_connections"."excess_permissions") <= 50 AND array_position("git_connections"."excess_permissions", NULL) IS NULL AND char_length(array_to_string("git_connections"."excess_permissions", '')) <= 5000),
	CONSTRAINT "git_connections_last_error" CHECK ("git_connections"."last_error" IS NULL OR char_length("git_connections"."last_error") <= 64)
);
--> statement-breakpoint
CREATE TABLE "git_repositories" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid,
	"base_url" text NOT NULL,
	"host_repo_id" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"project_id" uuid,
	"origin" text NOT NULL,
	"host_state" text DEFAULT 'active' NOT NULL,
	"is_private" boolean DEFAULT true NOT NULL,
	"default_branch_protected" boolean,
	"mirror_head_sha" text,
	"mirror_refreshed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_repositories_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "git_repositories_base_url" CHECK (char_length("git_repositories"."base_url") <= 2048 AND "git_repositories"."base_url" ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?(/[^?#[:space:]]*[^/?#[:space:]])?$'),
	CONSTRAINT "git_repositories_host_repo_id" CHECK (char_length("git_repositories"."host_repo_id") BETWEEN 1 AND 64 AND "git_repositories"."host_repo_id" ~ '^[A-Za-z0-9_=-]+$'),
	CONSTRAINT "git_repositories_full_name" CHECK (char_length("git_repositories"."full_name") <= 201 AND "git_repositories"."full_name" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9._-]+$'),
	CONSTRAINT "git_repositories_default_branch" CHECK (char_length("git_repositories"."default_branch") <= 255 AND char_length("git_repositories"."default_branch") >= 1),
	CONSTRAINT "git_repositories_origin" CHECK ("git_repositories"."origin" IN ('tool', 'conversion', 'link')),
	CONSTRAINT "git_repositories_host_state" CHECK ("git_repositories"."host_state" IN ('active', 'archived', 'deleted', 'unreachable')),
	CONSTRAINT "git_repositories_mirror_head" CHECK ("git_repositories"."mirror_head_sha" IS NULL OR "git_repositories"."mirror_head_sha" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$')
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "kind" text DEFAULT 'project' NOT NULL;--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_repositories" ADD CONSTRAINT "git_repositories_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_repositories" ADD CONSTRAINT "git_repositories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_connections_org_unique" ON "git_connections" USING btree ("team_id","base_url",lower("organization"));--> statement-breakpoint
CREATE INDEX "git_connections_created_by_idx" ON "git_connections" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "git_connections_updated_by_idx" ON "git_connections" USING btree ("updated_by");--> statement-breakpoint
CREATE UNIQUE INDEX "git_repositories_host_unique" ON "git_repositories" USING btree ("team_id","base_url","host_repo_id");--> statement-breakpoint
CREATE INDEX "git_repositories_connection_idx" ON "git_repositories" USING btree ("team_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_repositories_project_unique" ON "git_repositories" USING btree ("team_id","project_id");--> statement-breakpoint
CREATE INDEX "git_repositories_created_by_idx" ON "git_repositories" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_kind" CHECK ("projects"."kind" IN ('project', 'repo'));