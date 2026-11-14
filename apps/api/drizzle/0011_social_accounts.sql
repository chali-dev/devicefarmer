CREATE TABLE "social_account_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"group_id" uuid,
	"instance_id" uuid,
	"login_status" text DEFAULT 'unknown' NOT NULL,
	"account_status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
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
ALTER TABLE "social_account_groups" ADD CONSTRAINT "social_account_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_logs" ADD CONSTRAINT "social_account_logs_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_logs" ADD CONSTRAINT "social_account_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_tags" ADD CONSTRAINT "social_account_tags_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_account_tags" ADD CONSTRAINT "social_account_tags_tag_id_social_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."social_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_group_id_social_account_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."social_account_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "social_account_groups_user_name" ON "social_account_groups" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "social_account_logs_account_at_idx" ON "social_account_logs" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "social_account_tags_tag_idx" ON "social_account_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_platform_handle" ON "social_accounts" USING btree ("platform",lower("handle"));--> statement-breakpoint
CREATE INDEX "social_accounts_user_idx" ON "social_accounts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "social_accounts_group_idx" ON "social_accounts" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "social_accounts_instance_platform_idx" ON "social_accounts" USING btree ("instance_id","platform");--> statement-breakpoint
CREATE INDEX "social_accounts_status_idx" ON "social_accounts" USING btree ("login_status","account_status");--> statement-breakpoint
CREATE INDEX "social_accounts_created_at_idx" ON "social_accounts" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "social_tags_name_lower_idx" ON "social_tags" USING btree (lower("name"));