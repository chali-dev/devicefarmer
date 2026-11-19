ALTER TABLE "social_account_following" DROP CONSTRAINT "social_account_following_account_handle";--> statement-breakpoint
DROP INDEX "social_account_following_account_idx";--> statement-breakpoint
ALTER TABLE "social_account_following" ADD COLUMN "kind" text DEFAULT 'following' NOT NULL;--> statement-breakpoint
CREATE INDEX "social_account_following_account_idx" ON "social_account_following" USING btree ("social_account_id","kind","gone_at","position");--> statement-breakpoint
ALTER TABLE "social_account_following" ADD CONSTRAINT "social_account_following_account_kind_handle" UNIQUE("social_account_id","kind","handle");