-- redroid / local containers removed (owner 2026-11-20): every device is an external phone of a device source.
-- Rows of local containers can't run any more; they are removed (grants cascade, linked social accounts are unlinked).
DELETE FROM "instances" WHERE "source_id" IS NULL OR "external_id" IS NULL;--> statement-breakpoint
ALTER TABLE "instances" DROP CONSTRAINT "instances_proxy_id_unique";--> statement-breakpoint
ALTER TABLE "instances" DROP CONSTRAINT "instances_proxy_id_proxies_id_fk";--> statement-breakpoint
DROP TABLE "proxies" CASCADE;--> statement-breakpoint
ALTER TABLE "instances" ALTER COLUMN "engine" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "instances" ALTER COLUMN "source_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" ALTER COLUMN "external_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "instances" DROP COLUMN "profile";--> statement-breakpoint
ALTER TABLE "instances" DROP COLUMN "image";--> statement-breakpoint
ALTER TABLE "instances" DROP COLUMN "container_id";--> statement-breakpoint
ALTER TABLE "instances" DROP COLUMN "net_container_id";--> statement-breakpoint
ALTER TABLE "instances" DROP COLUMN "proxy_id";--> statement-breakpoint
ALTER TABLE "instances" DROP COLUMN "google";--> statement-breakpoint
ALTER TABLE "library_apps" DROP COLUMN "preinstall";
