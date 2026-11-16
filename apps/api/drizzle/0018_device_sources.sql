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
ALTER TABLE "instances" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "instances" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "device_sources" ADD CONSTRAINT "device_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_source_id_device_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."device_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_source_external_unique" UNIQUE("source_id","external_id");