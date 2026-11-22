CREATE TABLE "kobe_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_start" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "kobe_rate_limits_expires_at_idx" ON "kobe_rate_limits" USING btree ("expires_at");