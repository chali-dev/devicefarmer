CREATE TABLE "content_media" (
	"content_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "content_media_content_id_asset_id_pk" PRIMARY KEY("content_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "content_tag_links" (
	"content_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "content_tag_links_content_id_tag_id_pk" PRIMARY KEY("content_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "content_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"category" text,
	"stage" text DEFAULT 'draft' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"platform_hints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publish_task_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"attempt_no" integer,
	"task_id" uuid,
	"actor_id" uuid,
	"actor_name" text
);
--> statement-breakpoint
CREATE TABLE "publish_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"content_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"title" text,
	"caption" text DEFAULT '' NOT NULL,
	"hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"media_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"scheduled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text,
	"attempt_no" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"task_id" uuid,
	"republish" boolean DEFAULT false NOT NULL,
	"external_id" text,
	"url" text,
	"error" text,
	"error_code" text,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_media" ADD CONSTRAINT "content_media_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_media" ADD CONSTRAINT "content_media_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_tag_links" ADD CONSTRAINT "content_tag_links_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_tag_links" ADD CONSTRAINT "content_tag_links_tag_id_content_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."content_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_logs" ADD CONSTRAINT "publish_logs_publish_task_id_publish_tasks_id_fk" FOREIGN KEY ("publish_task_id") REFERENCES "public"."publish_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_logs" ADD CONSTRAINT "publish_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_tasks" ADD CONSTRAINT "publish_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_tasks" ADD CONSTRAINT "publish_tasks_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_tasks" ADD CONSTRAINT "publish_tasks_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_tasks" ADD CONSTRAINT "publish_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_media_asset_idx" ON "content_media" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "content_tag_links_tag_idx" ON "content_tag_links" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_tags_name_lower_idx" ON "content_tags" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "contents_user_created_idx" ON "contents" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "contents_user_status_idx" ON "contents" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "contents_user_category_idx" ON "contents" USING btree ("user_id","category");--> statement-breakpoint
CREATE INDEX "contents_created_at_idx" ON "contents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "publish_logs_task_at_idx" ON "publish_logs" USING btree ("publish_task_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_tasks_one_unfinished_idx" ON "publish_tasks" USING btree ("content_id","account_id") WHERE status in ('pending', 'scheduled', 'running', 'awaiting_operator');--> statement-breakpoint
CREATE INDEX "publish_tasks_user_scheduled_idx" ON "publish_tasks" USING btree ("user_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "publish_tasks_status_scheduled_idx" ON "publish_tasks" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "publish_tasks_scheduled_idx" ON "publish_tasks" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "publish_tasks_content_idx" ON "publish_tasks" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX "publish_tasks_account_idx" ON "publish_tasks" USING btree ("account_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "publish_tasks_media_idx" ON "publish_tasks" USING gin ("media_ids");