CREATE TABLE "risk_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"instance_id" uuid,
	"instance_name" text,
	"social_account_id" uuid,
	"tracked_account_id" uuid,
	"source" text NOT NULL,
	"code" text NOT NULL,
	"detail" text,
	"user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "social_account_stats" ADD COLUMN "approx" text[];--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "last_check_code" text;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "last_check_detail" text;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "risk_events_at_idx" ON "risk_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "risk_events_instance_at_idx" ON "risk_events" USING btree ("instance_id","at");--> statement-breakpoint
CREATE INDEX "risk_events_code_at_idx" ON "risk_events" USING btree ("code","at");