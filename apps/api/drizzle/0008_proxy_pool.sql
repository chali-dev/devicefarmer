CREATE TABLE "proxies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text,
	"type" text NOT NULL,
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
ALTER TABLE "instances" ADD COLUMN "proxy_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "proxies_endpoint_unique" ON "proxies" USING btree ("type",lower("host"),"port",coalesce("username", ''));--> statement-breakpoint
CREATE INDEX "proxies_status_idx" ON "proxies" USING btree ("status");--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_proxy_id_proxies_id_fk" FOREIGN KEY ("proxy_id") REFERENCES "public"."proxies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_proxy_id_unique" UNIQUE("proxy_id");