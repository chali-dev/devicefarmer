ALTER TABLE "required_apps" DROP CONSTRAINT "required_apps_package_unique";--> statement-breakpoint
ALTER TABLE "required_apps" ADD COLUMN "source_type" text DEFAULT 'bitbrowser' NOT NULL;--> statement-breakpoint
ALTER TABLE "required_apps" ADD COLUMN "store_app_id" text;--> statement-breakpoint
ALTER TABLE "required_apps" ADD CONSTRAINT "required_apps_source_package_unique" UNIQUE("source_type","package");--> statement-breakpoint
UPDATE "required_apps" SET "store_app_id" = "bitbrowser_app_id";
