CREATE TYPE "public"."instance_status" AS ENUM('creating', 'starting', 'running', 'stopping', 'stopped', 'restarting', 'deleting', 'error');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'operator', 'viewer');--> statement-breakpoint
CREATE TABLE "instance_grants" (
	"user_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	CONSTRAINT "instance_grants_user_id_instance_id_pk" PRIMARY KEY("user_id","instance_id")
);
--> statement-breakpoint
CREATE TABLE "instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"engine" text DEFAULT 'redroid' NOT NULL,
	"image" text NOT NULL,
	"adb_port" integer NOT NULL,
	"container_id" text,
	"status" "instance_status" DEFAULT 'creating' NOT NULL,
	"adb_state" text,
	"boot_completed" boolean DEFAULT false NOT NULL,
	"stf_ready" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"spec" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instances_name_unique" UNIQUE("name"),
	CONSTRAINT "instances_adb_port_unique" UNIQUE("adb_port")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"instance_id" uuid,
	"instance_name" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "role" DEFAULT 'viewer' NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "instance_grants" ADD CONSTRAINT "instance_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_grants" ADD CONSTRAINT "instance_grants_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;