CREATE TABLE "alert_states" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_alert_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_states_kind_key_pk" PRIMARY KEY("kind","key")
);
--> statement-breakpoint
CREATE TABLE "db_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger" text NOT NULL,
	"storage" text NOT NULL,
	"key" text NOT NULL,
	"size" bigint,
	"error" text,
	"task_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "instance_status_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "instance_status_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"instance_id" uuid NOT NULL,
	"field" text NOT NULL,
	"from" text,
	"to" text,
	"status" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"recovered" boolean DEFAULT false NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_account_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"social_account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"followers" bigint,
	"following" bigint,
	"posts" bigint,
	"total_views" bigint,
	"total_likes" bigint,
	"views" bigint,
	"likes" bigint,
	"shares" bigint,
	"comments" bigint,
	"missing" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" uuid,
	CONSTRAINT "social_account_stats_account_day" UNIQUE("social_account_id","day")
);
--> statement-breakpoint
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
ALTER TABLE "db_backups" ADD CONSTRAINT "db_backups_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_backups" ADD CONSTRAINT "db_backups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_status_events" ADD CONSTRAINT "instance_status_events_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_stats" ADD CONSTRAINT "social_account_stats_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_stats" ADD CONSTRAINT "social_account_stats_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trending_items" ADD CONSTRAINT "trending_items_snapshot_id_trending_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."trending_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_states_updated_idx" ON "alert_states" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "db_backups_created_idx" ON "db_backups" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "instance_status_events_instance_at_idx" ON "instance_status_events" USING btree ("instance_id","at");--> statement-breakpoint
CREATE INDEX "instance_status_events_at_idx" ON "instance_status_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE read_at is null;--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "trending_snapshots_captured_idx" ON "trending_snapshots" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "comment_templates_kind_idx" ON "comment_templates" USING btree ("kind","persona");--> statement-breakpoint
CREATE INDEX "tracked_accounts_next_refresh_idx" ON "tracked_accounts" USING btree ("next_refresh_at") WHERE refresh_interval_hours is not null;