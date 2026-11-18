ALTER TABLE "publish_tasks" ADD COLUMN "lang" text;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "lang" text;--> statement-breakpoint
CREATE INDEX "social_accounts_lang_idx" ON "social_accounts" USING btree ("lang");