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
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_categories_owner_name" UNIQUE NULLS NOT DISTINCT("owner_type","owner_id","name"),
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
ALTER TABLE "assets" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "assets" CASCADE;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ref_type" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ref_id" uuid;--> statement-breakpoint
ALTER TABLE "media_asset_tags" ADD CONSTRAINT "media_asset_tags_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_asset_tags" ADD CONSTRAINT "media_asset_tags_tag_id_media_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."media_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_category_id_media_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."media_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_categories" ADD CONSTRAINT "media_categories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_favorites" ADD CONSTRAINT "media_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_favorites" ADD CONSTRAINT "media_favorites_asset_id_media_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."media_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_asset_tags_tag_idx" ON "media_asset_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "media_assets_owner_idx" ON "media_assets" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "media_assets_category_idx" ON "media_assets" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "media_assets_status_idx" ON "media_assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "media_assets_created_at_idx" ON "media_assets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "media_assets_checksum_idx" ON "media_assets" USING btree ("checksum");--> statement-breakpoint
CREATE INDEX "media_favorites_asset_idx" ON "media_favorites" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_tags_name_lower_idx" ON "media_tags" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "tasks_ref_idx" ON "tasks" USING btree ("ref_type","ref_id");