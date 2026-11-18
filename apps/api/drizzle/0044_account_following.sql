CREATE TABLE "social_account_following" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"social_account_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"verified" boolean,
	"position" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"gone_at" timestamp with time zone,
	CONSTRAINT "social_account_following_account_handle" UNIQUE("social_account_id","handle")
);
--> statement-breakpoint
ALTER TABLE "social_account_following" ADD CONSTRAINT "social_account_following_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "social_account_following_account_idx" ON "social_account_following" USING btree ("social_account_id","gone_at","position");