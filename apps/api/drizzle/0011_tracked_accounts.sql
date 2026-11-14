CREATE TABLE "tracked_account_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracked_account_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"followers" bigint,
	"following" bigint,
	"posts" bigint,
	"views" bigint,
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
	"category" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"favorite" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"last_error_code" text,
	"last_source" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_accounts_user_platform_handle" UNIQUE("user_id","platform","handle")
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
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_posts_account_external" UNIQUE("tracked_account_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "tracked_account_snapshots" ADD CONSTRAINT "tracked_account_snapshots_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_account_snapshots" ADD CONSTRAINT "tracked_account_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_accounts" ADD CONSTRAINT "tracked_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_posts" ADD CONSTRAINT "tracked_posts_tracked_account_id_tracked_accounts_id_fk" FOREIGN KEY ("tracked_account_id") REFERENCES "public"."tracked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tracked_snapshots_account_at_idx" ON "tracked_account_snapshots" USING btree ("tracked_account_id","captured_at");--> statement-breakpoint
CREATE INDEX "tracked_accounts_user_status_idx" ON "tracked_accounts" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "tracked_accounts_user_category_idx" ON "tracked_accounts" USING btree ("user_id","category");--> statement-breakpoint
CREATE INDEX "tracked_accounts_user_favorite_idx" ON "tracked_accounts" USING btree ("user_id","favorite");--> statement-breakpoint
CREATE INDEX "tracked_accounts_tags_idx" ON "tracked_accounts" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "tracked_posts_account_published_idx" ON "tracked_posts" USING btree ("tracked_account_id","published_at");