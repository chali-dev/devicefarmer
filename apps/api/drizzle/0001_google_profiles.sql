ALTER TABLE "instances" ADD COLUMN "profile" text DEFAULT 'redroid-12' NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "google" jsonb;