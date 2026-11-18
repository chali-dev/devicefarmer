ALTER TABLE "comment_tasks" ADD COLUMN "tracked_post_id" uuid;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD COLUMN "tracked_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_tracked_post_id_tracked_posts_id_fk" FOREIGN KEY ("tracked_post_id") REFERENCES "public"."tracked_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_tasks_tracked_post_idx" ON "comment_tasks" USING btree ("tracked_post_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_tasks_tracked_one_active_idx" ON "comment_tasks" USING btree ("tracked_comment_id") WHERE tracked_comment_id is not null and status not in ('failed', 'rejected', 'cancelled', 'dry_run');