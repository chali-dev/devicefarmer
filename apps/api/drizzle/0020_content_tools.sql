CREATE TABLE "trending_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"video_id" text NOT NULL,
	"title" text,
	"channel_id" text,
	"channel_title" text,
	"category_id" text,
	"views" bigint,
	"likes" bigint,
	"comments" bigint,
	"published_at" timestamp with time zone,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "trending_items_snapshot_rank" UNIQUE("snapshot_id","rank")
);
--> statement-breakpoint
CREATE TABLE "trending_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text DEFAULT 'youtube' NOT NULL,
	"region" text NOT NULL,
	"category_id" text DEFAULT '' NOT NULL,
	"slot_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"task_id" uuid,
	CONSTRAINT "trending_snapshots_slot" UNIQUE("source","region","category_id","slot_at")
);
--> statement-breakpoint
ALTER TABLE "comment_templates" ADD COLUMN "kind" text DEFAULT 'comment' NOT NULL;--> statement-breakpoint
ALTER TABLE "comment_templates" ADD COLUMN "persona" text;--> statement-breakpoint
ALTER TABLE "comment_templates" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tracked_accounts" ADD COLUMN "refresh_interval_hours" integer;--> statement-breakpoint
ALTER TABLE "tracked_accounts" ADD COLUMN "next_refresh_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tracked_accounts" ADD COLUMN "schedule_skip_code" text;--> statement-breakpoint
ALTER TABLE "trending_items" ADD CONSTRAINT "trending_items_snapshot_id_trending_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."trending_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trending_snapshots_captured_idx" ON "trending_snapshots" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "comment_templates_kind_idx" ON "comment_templates" USING btree ("kind","persona");--> statement-breakpoint
CREATE INDEX "tracked_accounts_next_refresh_idx" ON "tracked_accounts" USING btree ("next_refresh_at") WHERE refresh_interval_hours is not null;