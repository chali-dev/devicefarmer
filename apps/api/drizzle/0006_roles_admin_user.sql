-- Two roles: admin / user. Postgres cannot drop enum values, so the type is recreated;
-- existing 'operator' / 'viewer' rows become 'user'.
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
UPDATE "users" SET "role" = 'user' WHERE "role" <> 'admin';--> statement-breakpoint
DROP TYPE "public"."role";--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'user');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE "public"."role" USING "role"::"public"."role";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'user'::"public"."role";--> statement-breakpoint
-- Built-in admin (ADMIN_USERNAME): flagged by `npm run db:seed`, which knows the configured name.
ALTER TABLE "users" ADD COLUMN "builtin" boolean DEFAULT false NOT NULL;
