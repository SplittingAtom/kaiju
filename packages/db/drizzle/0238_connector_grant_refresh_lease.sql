ALTER TABLE "connector_grants" ADD COLUMN "refresh_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_grants" ADD COLUMN "refresh_lease_owner" uuid;