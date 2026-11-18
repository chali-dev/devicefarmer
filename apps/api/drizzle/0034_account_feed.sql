CREATE TABLE "tracked_post_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracked_post_id" uuid NOT NULL,
	"tracked_account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"author_handle" text,
	"text" text NOT NULL,
	"likes" integer,
	"reply_count" integer,
	"position" integer,
	"published_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_post_comments_post_external" UNIQUE("tracked_post_id","external_id")
);
--> statement-breakpoint
DROP INDEX "comment_tasks_one_active_idx";--> statement-breakpoint
ALTER TABLE "comment_tasks" ALTER COLUMN "comment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD COLUMN "post_id" uuid;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
ALTER TABLE "social_account_posts" ADD COLUMN "source" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE "social_account_posts" ADD COLUMN "approx" text[];--> statement-breakpoint
ALTER TABLE "social_account_posts" ADD COLUMN "comments_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tracked_posts" ADD COLUMN "media_type" text;--> statement-breakpoint
ALTER TABLE "tracked_posts" ADD COLUMN "approx" text[];--> statement-breakpoint
ALTER TABLE "tracked_posts" ADD COLUMN "comments_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tracked_post_comments" ADD CONSTRAINT "tracked_post_comments_tracked_post_id_tracked_posts_id_fk" FOREIGN KEY ("tracked_post_id") REFERENCES "public"."tracked_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_post_comments" ADD CONSTRAINT "tracked_post_comments_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tracked_post_comments_account_idx" ON "tracked_post_comments" USING btree ("tracked_account_id","first_seen_at");--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_post_id_social_account_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."social_account_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_tasks_post_idx" ON "comment_tasks" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_tasks_one_active_idx" ON "comment_tasks" USING btree ("comment_id") WHERE status not in ('failed', 'rejected', 'cancelled', 'dry_run');