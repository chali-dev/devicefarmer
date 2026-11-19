CREATE INDEX "publish_tasks_pair_idx" ON "publish_tasks" USING btree ("content_id","account_id","user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "publish_tasks_updated_idx" ON "publish_tasks" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "comment_tasks_updated_idx" ON "comment_tasks" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "comments_when_idx" ON "comments" USING btree (coalesce("published_at", "created_at"),"id");--> statement-breakpoint
DROP INDEX "publish_tasks_content_idx";
