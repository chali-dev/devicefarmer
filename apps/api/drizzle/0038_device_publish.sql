ALTER TABLE "publish_tasks" ADD COLUMN "device_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publish_tasks" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
CREATE INDEX "publish_tasks_account_device_idx" ON "publish_tasks" USING btree ("account_id","device_run_at");