ALTER TABLE "instances" ADD COLUMN "net_container_id" text;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "proxy" jsonb;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "proxy_status" jsonb;