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
ALTER TABLE "db_backups" ADD CONSTRAINT "db_backups_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_backups" ADD CONSTRAINT "db_backups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_status_events" ADD CONSTRAINT "instance_status_events_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "db_backups_created_idx" ON "db_backups" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "instance_status_events_instance_at_idx" ON "instance_status_events" USING btree ("instance_id","at");--> statement-breakpoint
CREATE INDEX "instance_status_events_at_idx" ON "instance_status_events" USING btree ("at");