CREATE TABLE "social_account_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"social_account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"followers" bigint,
	"following" bigint,
	"posts" bigint,
	"total_views" bigint,
	"total_likes" bigint,
	"views" bigint,
	"likes" bigint,
	"shares" bigint,
	"comments" bigint,
	"missing" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" uuid,
	CONSTRAINT "social_account_stats_account_day" UNIQUE("social_account_id","day")
);
--> statement-breakpoint
ALTER TABLE "social_account_stats" ADD CONSTRAINT "social_account_stats_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_stats" ADD CONSTRAINT "social_account_stats_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;