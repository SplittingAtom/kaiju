CREATE TABLE "budget_email_daily_counts" (
	"recipient_id" uuid NOT NULL,
	"day" date NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "budget_email_daily_counts_recipient_id_day_pk" PRIMARY KEY("recipient_id","day"),
	CONSTRAINT "budget_email_daily_counts_sent" CHECK ("budget_email_daily_counts"."sent" >= 0)
);
--> statement-breakpoint
ALTER TABLE "budget_email_daily_counts" ADD CONSTRAINT "budget_email_daily_counts_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_email_daily_counts_day_idx" ON "budget_email_daily_counts" USING btree ("day");