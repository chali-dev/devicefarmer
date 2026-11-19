ALTER TABLE "social_account_following" ADD COLUMN "followers" integer;--> statement-breakpoint
ALTER TABLE "social_account_following" ADD COLUMN "following" integer;--> statement-breakpoint
ALTER TABLE "social_account_following" ADD COLUMN "posts" integer;--> statement-breakpoint
ALTER TABLE "social_account_following" ADD COLUMN "approx" text[];--> statement-breakpoint
ALTER TABLE "social_account_following" ADD COLUMN "is_private" boolean;--> statement-breakpoint
ALTER TABLE "social_account_following" ADD COLUMN "profile_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "social_account_following" ADD COLUMN "profile_code" text;