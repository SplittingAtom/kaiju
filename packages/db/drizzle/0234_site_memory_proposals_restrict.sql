ALTER TABLE "site_memory_proposals" DROP CONSTRAINT "site_memory_proposals_from_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "site_memory_proposals" ADD CONSTRAINT "site_memory_proposals_from_team_id_teams_id_fk" FOREIGN KEY ("from_team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;