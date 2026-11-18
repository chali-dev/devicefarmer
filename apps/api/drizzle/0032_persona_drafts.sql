ALTER TABLE "contents" ADD COLUMN "ai_generated" jsonb;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "draft_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "drafts_per_day" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "brief" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "draft_owner_id" uuid;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_draft_owner_id_users_id_fk" FOREIGN KEY ("draft_owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;