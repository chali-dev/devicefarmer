CREATE TABLE "content_targets" (
	"content_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "content_targets_content_id_account_id_pk" PRIMARY KEY("content_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "persona_id" uuid;--> statement-breakpoint
ALTER TABLE "content_targets" ADD CONSTRAINT "content_targets_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_targets" ADD CONSTRAINT "content_targets_account_id_social_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_targets_account_idx" ON "content_targets" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "social_accounts_persona_idx" ON "social_accounts" USING btree ("persona_id");