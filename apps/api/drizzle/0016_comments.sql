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
CREATE TABLE "comment_sync_states" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"cursor" text,
	"last_task_id" uuid,
	"last_synced_at" timestamp with time zone,
	"last_fetched" integer,
	"last_new" integer,
	"last_error" text,
	"last_error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comment_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
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
	"reviewer_id" uuid,
	"reviewer_name" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
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
ALTER TABLE "comment_logs" ADD CONSTRAINT "comment_logs_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_logs" ADD CONSTRAINT "comment_logs_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_logs" ADD CONSTRAINT "comment_logs_comment_task_id_comment_tasks_id_fk" FOREIGN KEY ("comment_task_id") REFERENCES "public"."comment_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_logs" ADD CONSTRAINT "comment_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_sync_states" ADD CONSTRAINT "comment_sync_states_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_tasks" ADD CONSTRAINT "comment_tasks_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_templates" ADD CONSTRAINT "comment_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_templates" ADD CONSTRAINT "comment_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_publish_task_id_publish_tasks_id_fk" FOREIGN KEY ("publish_task_id") REFERENCES "public"."publish_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_logs_task_at_idx" ON "comment_logs" USING btree ("comment_task_id","at");--> statement-breakpoint
CREATE INDEX "comment_logs_comment_at_idx" ON "comment_logs" USING btree ("comment_id","at");--> statement-breakpoint
CREATE INDEX "comment_logs_account_at_idx" ON "comment_logs" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "comment_logs_code_idx" ON "comment_logs" USING btree ("code","at");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_tasks_one_active_idx" ON "comment_tasks" USING btree ("comment_id") WHERE status not in ('failed', 'rejected', 'cancelled');--> statement-breakpoint
CREATE INDEX "comment_tasks_user_status_idx" ON "comment_tasks" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "comment_tasks_account_status_idx" ON "comment_tasks" USING btree ("account_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "comment_tasks_account_hash_idx" ON "comment_tasks" USING btree ("account_id","text_hash","submitted_at");--> statement-breakpoint
CREATE INDEX "comment_tasks_account_sent_idx" ON "comment_tasks" USING btree ("account_id","sent_at");--> statement-breakpoint
CREATE INDEX "comment_tasks_status_idx" ON "comment_tasks" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "comment_tasks_comment_idx" ON "comment_tasks" USING btree ("comment_id","created_at");--> statement-breakpoint
CREATE INDEX "comment_templates_user_idx" ON "comment_templates" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "comments_account_external_idx" ON "comments" USING btree ("account_id","external_id");--> statement-breakpoint
CREATE INDEX "comments_user_published_idx" ON "comments" USING btree ("user_id","published_at");--> statement-breakpoint
CREATE INDEX "comments_account_status_idx" ON "comments" USING btree ("account_id","status","published_at");--> statement-breakpoint
CREATE INDEX "comments_account_post_idx" ON "comments" USING btree ("account_id","external_post_id");--> statement-breakpoint
CREATE INDEX "comments_account_parent_idx" ON "comments" USING btree ("account_id","parent_external_id");--> statement-breakpoint
CREATE INDEX "comments_status_idx" ON "comments" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "comments_publish_task_idx" ON "comments" USING btree ("publish_task_id");