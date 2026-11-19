CREATE TYPE "public"."instance_status" AS ENUM('creating', 'starting', 'running', 'stopping', 'stopped', 'restarting', 'deleting', 'error');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'user');--> statement-breakpoint
CREATE TABLE "alert_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"min_severity" text,
	"last_result" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_channels_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "alert_states" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_alert_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_states_kind_key_pk" PRIMARY KEY("kind","key")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"username" text,
	"action" text NOT NULL,
	"target" text,
	"target_id" text,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"ok" boolean NOT NULL,
	"ip" text,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "comment_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"comment_id" uuid,
	"comment_task_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"action" text NOT NULL,
	"code" text,
	"message" text,
	"data" jsonb,
	"task_id" uuid,
	"actor_id" uuid,
	"actor_name" text
);
--> statement-breakpoint
CREATE TABLE "comment_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"comment_id" uuid,
	"post_id" uuid,
	"tracked_post_id" uuid,
	"tracked_comment_id" uuid,
	"evidence" jsonb,
	"platform" text NOT NULL,
	"text" text NOT NULL,
	"text_hash" text NOT NULL,
	"template_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"method" text,
	"scheduled_at" timestamp with time zone,
	"round" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"task_id" uuid,
	"external_reply_id" text,
	"error" text,
	"error_code" text,
	"author_id" uuid,
	"author_name" text,
	"submitted_at" timestamp with time zone,
	"sender_id" uuid,
	"sender_name" text,
	"handed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comment_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"persona_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"name" text NOT NULL,
	"text" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"parent_external_id" text,
	"external_post_id" text,
	"post_url" text,
	"publish_task_id" uuid,
	"author_name" text,
	"author_handle" text,
	"text" text NOT NULL,
	"like_count" integer,
	"reply_count" integer,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_categories_owner_chk" CHECK ((owner_type = 'public' and owner_id is null) or (owner_type = 'user' and owner_id is not null))
);
--> statement-breakpoint
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
CREATE TABLE "content_targets" (
	"content_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "content_targets_content_id_account_id_pk" PRIMARY KEY("content_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "content_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"lang" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"platform_hints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_translations_content_lang_unique" UNIQUE("content_id","lang")
);
--> statement-breakpoint
CREATE TABLE "contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"category_id" uuid,
	"lang" text,
	"stage" text DEFAULT 'draft' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"platform_hints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_generated" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "device_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_sources_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "instance_grants" (
	"user_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	CONSTRAINT "instance_grants_user_id_instance_id_pk" PRIMARY KEY("user_id","instance_id")
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
CREATE TABLE "instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"engine" text DEFAULT 'redroid' NOT NULL,
	"source_id" uuid,
	"external_id" text,
	"profile" text DEFAULT 'redroid-12' NOT NULL,
	"image" text NOT NULL,
	"adb_port" integer NOT NULL,
	"container_id" text,
	"net_container_id" text,
	"proxy_id" uuid,
	"proxy_status" jsonb,
	"status" "instance_status" DEFAULT 'creating' NOT NULL,
	"adb_state" text,
	"boot_completed" boolean DEFAULT false NOT NULL,
	"stf_ready" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"google" jsonb,
	"spec" jsonb NOT NULL,
	"allowed_platforms" text[],
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instances_name_unique" UNIQUE("name"),
	CONSTRAINT "instances_adb_port_unique" UNIQUE("adb_port"),
	CONSTRAINT "instances_proxy_id_unique" UNIQUE("proxy_id"),
	CONSTRAINT "instances_source_external_unique" UNIQUE("source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "library_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package" text NOT NULL,
	"version_name" text,
	"version_code" text NOT NULL,
	"files" jsonb NOT NULL,
	"preinstall" boolean DEFAULT false NOT NULL,
	"source_instance" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_pkg_version" UNIQUE("package","version_code")
);
--> statement-breakpoint
CREATE TABLE "media_asset_tags" (
	"asset_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "media_asset_tags_asset_id_tag_id_pk" PRIMARY KEY("asset_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid,
	"category_id" uuid,
	"name" text NOT NULL,
	"file_name" text NOT NULL,
	"storage" text NOT NULL,
	"file_key" text NOT NULL,
	"thumbnail_key" text,
	"file_type" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"duration" double precision,
	"checksum" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"error" text,
	"processing" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "media_assets_owner_chk" CHECK ((owner_type = 'public' and owner_id is null) or (owner_type = 'user' and owner_id is not null))
);
--> statement-breakpoint
CREATE TABLE "media_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_categories_owner_chk" CHECK ((owner_type = 'public' and owner_id is null) or (owner_type = 'user' and owner_id is not null))
);
--> statement-breakpoint
CREATE TABLE "media_favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_favorites_user_asset" UNIQUE("user_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "media_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"brief" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"custom_prompt" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personas_owner_chk" CHECK ((owner_type = 'public' and owner_id is null) or (owner_type = 'user' and owner_id is not null))
);
--> statement-breakpoint
CREATE TABLE "proxies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text,
	"type" text NOT NULL,
	"kind" text DEFAULT 'static' NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"username" text,
	"password_enc" text,
	"country" text,
	"region" text,
	"city" text,
	"provider" text,
	"notes" text,
	"status" text DEFAULT 'unchecked' NOT NULL,
	"last_check" jsonb,
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
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"media_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"post_type" text DEFAULT 'feed' NOT NULL,
	"lang" text,
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
	"device_run_at" timestamp with time zone,
	"evidence" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"instance_id" uuid,
	"instance_name" text,
	"social_account_id" uuid,
	"tracked_account_id" uuid,
	"source" text NOT NULL,
	"code" text NOT NULL,
	"detail" text,
	"user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"menus" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_account_following" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"social_account_id" uuid NOT NULL,
	"kind" text DEFAULT 'following' NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"verified" boolean,
	"position" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gone_at" timestamp with time zone,
	"followers" integer,
	"following" integer,
	"posts" integer,
	"approx" text[],
	"is_private" boolean,
	"profile_checked_at" timestamp with time zone,
	"profile_code" text,
	CONSTRAINT "social_account_following_account_kind_handle" UNIQUE("social_account_id","kind","handle")
);
--> statement-breakpoint
CREATE TABLE "social_account_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_name" text,
	"action" text NOT NULL,
	"field" text,
	"from_value" text,
	"to_value" text,
	"message" text
);
--> statement-breakpoint
CREATE TABLE "social_account_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"social_account_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_id" text NOT NULL,
	"media_type" text,
	"product_type" text,
	"caption" text,
	"permalink" text,
	"published_at" timestamp with time zone,
	"likes" bigint,
	"comments" bigint,
	"source" text DEFAULT 'api' NOT NULL,
	"approx" text[],
	"comments_fetched_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_account_posts_account_external" UNIQUE("social_account_id","external_id")
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
	"approx" text[],
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
CREATE TABLE "social_account_tags" (
	"account_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "social_account_tags_account_id_tag_id_pk" PRIMARY KEY("account_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "social_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"profile_url" text,
	"external_id" text,
	"instance_id" uuid,
	"persona_id" uuid,
	"lang" text,
	"login_status" text DEFAULT 'unknown' NOT NULL,
	"account_status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"last_check_code" text,
	"last_check_detail" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"instance_id" uuid,
	"instance_name" text,
	"ref_type" text,
	"ref_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"timeout_ms" integer,
	"priority" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"retry_of" uuid,
	"run_at" timestamp with time zone,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"error" text,
	"error_code" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_account_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracked_account_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"followers" bigint,
	"following" bigint,
	"posts" bigint,
	"views" bigint,
	"approx" text[],
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "tracked_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"profile_url" text NOT NULL,
	"external_id" text,
	"display_name" text,
	"avatar_url" text,
	"bio" text,
	"instance_id" uuid,
	"verified" boolean,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"favorite" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"last_error_code" text,
	"last_source" text,
	"notes" text,
	"refresh_interval_hours" integer,
	"next_refresh_at" timestamp with time zone,
	"schedule_skip_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_accounts_user_platform_handle" UNIQUE("user_id","platform","handle")
);
--> statement-breakpoint
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
CREATE TABLE "tracked_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracked_account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"title" text,
	"published_at" timestamp with time zone,
	"views" bigint,
	"likes" bigint,
	"comments" bigint,
	"source" text NOT NULL,
	"media_type" text,
	"approx" text[],
	"comments_fetched_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_posts_account_external" UNIQUE("tracked_account_id","external_id")
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
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "role" DEFAULT 'user' NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"display_name" text,
	"email" text,
	"role_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "alert_channels" ADD CONSTRAINT "alert_channels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_logs" ADD CONSTRAINT "comment_logs_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_logs" ADD CONSTRAINT "comment_logs_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_logs" ADD CONSTRAINT "comment_logs_comment_task_id_comment_tasks_id_fk" FOREIGN KEY ("comment_task_id") REFERENCES "public"."comment_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_logs" ADD CONSTRAINT "comment_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_post_id_social_account_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."social_account_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_tracked_post_id_tracked_posts_id_fk" FOREIGN KEY ("tracked_post_id") REFERENCES "public"."tracked_posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_templates" ADD CONSTRAINT "comment_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_templates" ADD CONSTRAINT "comment_templates_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_templates" ADD CONSTRAINT "comment_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_publish_task_id_publish_tasks_id_fk" FOREIGN KEY ("publish_task_id") REFERENCES "public"."publish_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_categories" ADD CONSTRAINT "content_categories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_categories" ADD CONSTRAINT "content_categories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_media" ADD CONSTRAINT "content_media_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_media" ADD CONSTRAINT "content_media_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_tag_links" ADD CONSTRAINT "content_tag_links_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_tag_links" ADD CONSTRAINT "content_tag_links_tag_id_content_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."content_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_targets" ADD CONSTRAINT "content_targets_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_targets" ADD CONSTRAINT "content_targets_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_translations" ADD CONSTRAINT "content_translations_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_category_id_content_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."content_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_backups" ADD CONSTRAINT "db_backups_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_backups" ADD CONSTRAINT "db_backups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_sources" ADD CONSTRAINT "device_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_grants" ADD CONSTRAINT "instance_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_grants" ADD CONSTRAINT "instance_grants_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_status_events" ADD CONSTRAINT "instance_status_events_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_source_id_device_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."device_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_proxy_id_proxies_id_fk" FOREIGN KEY ("proxy_id") REFERENCES "public"."proxies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_asset_tags" ADD CONSTRAINT "media_asset_tags_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_asset_tags" ADD CONSTRAINT "media_asset_tags_tag_id_media_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."media_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_category_id_media_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."media_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_categories" ADD CONSTRAINT "media_categories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_favorites" ADD CONSTRAINT "media_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_favorites" ADD CONSTRAINT "media_favorites_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_logs" ADD CONSTRAINT "publish_logs_publish_task_id_publish_tasks_id_fk" FOREIGN KEY ("publish_task_id") REFERENCES "public"."publish_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_logs" ADD CONSTRAINT "publish_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_tasks" ADD CONSTRAINT "publish_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_tasks" ADD CONSTRAINT "publish_tasks_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_tasks" ADD CONSTRAINT "publish_tasks_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publish_tasks" ADD CONSTRAINT "publish_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_following" ADD CONSTRAINT "social_account_following_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_logs" ADD CONSTRAINT "social_account_logs_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_logs" ADD CONSTRAINT "social_account_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_posts" ADD CONSTRAINT "social_account_posts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_stats" ADD CONSTRAINT "social_account_stats_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_stats" ADD CONSTRAINT "social_account_stats_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_tags" ADD CONSTRAINT "social_account_tags_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_tags" ADD CONSTRAINT "social_account_tags_tag_id_social_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."social_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_account_snapshots" ADD CONSTRAINT "tracked_account_snapshots_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_account_snapshots" ADD CONSTRAINT "tracked_account_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_accounts" ADD CONSTRAINT "tracked_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_accounts" ADD CONSTRAINT "tracked_accounts_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_post_comments" ADD CONSTRAINT "tracked_post_comments_tracked_post_id_tracked_posts_id_fk" FOREIGN KEY ("tracked_post_id") REFERENCES "public"."tracked_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_post_comments" ADD CONSTRAINT "tracked_post_comments_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_posts" ADD CONSTRAINT "tracked_posts_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trending_items" ADD CONSTRAINT "trending_items_snapshot_id_trending_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."trending_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_states_updated_idx" ON "alert_states" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "audit_logs_at_idx" ON "audit_logs" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "comment_logs_task_at_idx" ON "comment_logs" USING btree ("comment_task_id","at");--> statement-breakpoint
CREATE INDEX "comment_logs_comment_at_idx" ON "comment_logs" USING btree ("comment_id","at");--> statement-breakpoint
CREATE INDEX "comment_logs_account_at_idx" ON "comment_logs" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "comment_logs_code_idx" ON "comment_logs" USING btree ("code","at");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_tasks_one_active_idx" ON "comment_tasks" USING btree ("comment_id") WHERE status not in ('failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "comment_tasks_post_idx" ON "comment_tasks" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE INDEX "comment_tasks_tracked_post_idx" ON "comment_tasks" USING btree ("tracked_post_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_tasks_tracked_one_active_idx" ON "comment_tasks" USING btree ("tracked_comment_id") WHERE tracked_comment_id is not null and status not in ('failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "comment_tasks_user_status_idx" ON "comment_tasks" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "comment_tasks_account_status_idx" ON "comment_tasks" USING btree ("account_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "comment_tasks_account_hash_idx" ON "comment_tasks" USING btree ("account_id","text_hash","submitted_at");--> statement-breakpoint
CREATE INDEX "comment_tasks_account_sent_idx" ON "comment_tasks" USING btree ("account_id","sent_at");--> statement-breakpoint
CREATE INDEX "comment_tasks_status_idx" ON "comment_tasks" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "comment_tasks_updated_idx" ON "comment_tasks" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "comment_tasks_comment_idx" ON "comment_tasks" USING btree ("comment_id","created_at");--> statement-breakpoint
CREATE INDEX "comment_templates_user_idx" ON "comment_templates" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "comment_templates_persona_idx" ON "comment_templates" USING btree ("persona_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comments_account_external_idx" ON "comments" USING btree ("account_id","external_id");--> statement-breakpoint
CREATE INDEX "comments_user_published_idx" ON "comments" USING btree ("user_id","published_at");--> statement-breakpoint
CREATE INDEX "comments_when_idx" ON "comments" USING btree (coalesce("published_at", "created_at"),"id");--> statement-breakpoint
CREATE INDEX "comments_account_status_idx" ON "comments" USING btree ("account_id","status","published_at");--> statement-breakpoint
CREATE INDEX "comments_account_post_idx" ON "comments" USING btree ("account_id","external_post_id");--> statement-breakpoint
CREATE INDEX "comments_account_parent_idx" ON "comments" USING btree ("account_id","parent_external_id");--> statement-breakpoint
CREATE INDEX "comments_status_idx" ON "comments" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "comments_publish_task_idx" ON "comments" USING btree ("publish_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_categories_owner_name" ON "content_categories" USING btree (coalesce("owner_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE INDEX "content_media_asset_idx" ON "content_media" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "content_tag_links_tag_idx" ON "content_tag_links" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_tags_name_lower_idx" ON "content_tags" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "content_targets_account_idx" ON "content_targets" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "content_translations_lang_idx" ON "content_translations" USING btree ("lang");--> statement-breakpoint
CREATE INDEX "contents_user_created_idx" ON "contents" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "contents_user_status_idx" ON "contents" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "contents_category_id_idx" ON "contents" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "contents_created_at_idx" ON "contents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "db_backups_created_idx" ON "db_backups" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "instance_status_events_instance_at_idx" ON "instance_status_events" USING btree ("instance_id","at");--> statement-breakpoint
CREATE INDEX "instance_status_events_at_idx" ON "instance_status_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "media_asset_tags_tag_idx" ON "media_asset_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "media_assets_owner_idx" ON "media_assets" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "media_assets_category_idx" ON "media_assets" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "media_assets_status_idx" ON "media_assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "media_assets_created_at_idx" ON "media_assets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "media_assets_checksum_idx" ON "media_assets" USING btree ("checksum");--> statement-breakpoint
CREATE UNIQUE INDEX "media_categories_owner_name_lower" ON "media_categories" USING btree (coalesce("owner_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE INDEX "media_favorites_asset_idx" ON "media_favorites" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_tags_name_lower_idx" ON "media_tags" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE read_at is null;--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "personas_owner_name" ON "personas" USING btree (coalesce("owner_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "proxies_endpoint_unique" ON "proxies" USING btree ("type",lower("host"),"port",coalesce("username", ''));--> statement-breakpoint
CREATE INDEX "proxies_status_idx" ON "proxies" USING btree ("status");--> statement-breakpoint
CREATE INDEX "proxies_kind_idx" ON "proxies" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "publish_logs_task_at_idx" ON "publish_logs" USING btree ("publish_task_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "publish_tasks_one_unfinished_idx" ON "publish_tasks" USING btree ("content_id","account_id") WHERE status in ('pending', 'scheduled', 'running', 'awaiting_operator');--> statement-breakpoint
CREATE INDEX "publish_tasks_user_scheduled_idx" ON "publish_tasks" USING btree ("user_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "publish_tasks_status_scheduled_idx" ON "publish_tasks" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "publish_tasks_scheduled_idx" ON "publish_tasks" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "publish_tasks_pair_idx" ON "publish_tasks" USING btree ("content_id","account_id","user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "publish_tasks_updated_idx" ON "publish_tasks" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "publish_tasks_account_idx" ON "publish_tasks" USING btree ("account_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "publish_tasks_media_idx" ON "publish_tasks" USING gin ("media_ids");--> statement-breakpoint
CREATE INDEX "publish_tasks_account_device_idx" ON "publish_tasks" USING btree ("account_id","device_run_at");--> statement-breakpoint
CREATE INDEX "risk_events_at_idx" ON "risk_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "risk_events_instance_at_idx" ON "risk_events" USING btree ("instance_id","at");--> statement-breakpoint
CREATE INDEX "risk_events_code_at_idx" ON "risk_events" USING btree ("code","at");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_name_lower" ON "roles" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "social_account_following_account_idx" ON "social_account_following" USING btree ("social_account_id","kind","gone_at","position");--> statement-breakpoint
CREATE INDEX "social_account_logs_account_at_idx" ON "social_account_logs" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "social_account_posts_account_published_idx" ON "social_account_posts" USING btree ("social_account_id","published_at");--> statement-breakpoint
CREATE INDEX "social_account_tags_tag_idx" ON "social_account_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_platform_handle" ON "social_accounts" USING btree ("platform",lower("handle"));--> statement-breakpoint
CREATE INDEX "social_accounts_user_idx" ON "social_accounts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "social_accounts_instance_platform_idx" ON "social_accounts" USING btree ("instance_id","platform");--> statement-breakpoint
CREATE INDEX "social_accounts_status_idx" ON "social_accounts" USING btree ("login_status","account_status");--> statement-breakpoint
CREATE INDEX "social_accounts_created_at_idx" ON "social_accounts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "social_accounts_persona_idx" ON "social_accounts" USING btree ("persona_id");--> statement-breakpoint
CREATE INDEX "social_accounts_lang_idx" ON "social_accounts" USING btree ("lang");--> statement-breakpoint
CREATE UNIQUE INDEX "social_tags_name_lower_idx" ON "social_tags" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "task_logs_task_idx" ON "task_logs" USING btree ("task_id","ts");--> statement-breakpoint
CREATE INDEX "tasks_ref_idx" ON "tasks" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "tasks_type_idx" ON "tasks" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "tasks_created_by_idx" ON "tasks" USING btree ("created_by","created_at");--> statement-breakpoint
CREATE INDEX "tasks_instance_idx" ON "tasks" USING btree ("instance_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_created_at_idx" ON "tasks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tasks_run_at_idx" ON "tasks" USING btree ("run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_idem_idx" ON "tasks" USING btree ("type","idempotency_key") WHERE idempotency_key is not null;--> statement-breakpoint
CREATE INDEX "tracked_snapshots_account_at_idx" ON "tracked_account_snapshots" USING btree ("tracked_account_id","captured_at");--> statement-breakpoint
CREATE INDEX "tracked_accounts_next_refresh_idx" ON "tracked_accounts" USING btree ("next_refresh_at") WHERE refresh_interval_hours is not null;--> statement-breakpoint
CREATE INDEX "tracked_accounts_user_status_idx" ON "tracked_accounts" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "tracked_accounts_user_favorite_idx" ON "tracked_accounts" USING btree ("user_id","favorite");--> statement-breakpoint
CREATE INDEX "tracked_accounts_tags_idx" ON "tracked_accounts" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "tracked_accounts_instance_idx" ON "tracked_accounts" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "tracked_post_comments_account_idx" ON "tracked_post_comments" USING btree ("tracked_account_id","first_seen_at");--> statement-breakpoint
CREATE INDEX "tracked_posts_account_published_idx" ON "tracked_posts" USING btree ("tracked_account_id","published_at");--> statement-breakpoint
CREATE INDEX "trending_snapshots_captured_idx" ON "trending_snapshots" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "users_role_id_idx" ON "users" USING btree ("role_id");