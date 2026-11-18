ALTER TABLE "tracked_account_snapshots" ADD COLUMN "approx" text[];--> statement-breakpoint
ALTER TABLE "tracked_accounts" ADD COLUMN "verified" boolean;