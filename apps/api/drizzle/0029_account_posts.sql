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
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_account_posts_account_external" UNIQUE("social_account_id","external_id")
);
--> statement-breakpoint
ALTER TABLE "social_account_posts" ADD CONSTRAINT "social_account_posts_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "social_account_posts_account_published_idx" ON "social_account_posts" USING btree ("social_account_id","published_at");