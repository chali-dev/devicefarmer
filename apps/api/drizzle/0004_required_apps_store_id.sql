ALTER TABLE "required_apps" ALTER COLUMN "source_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "required_apps" ALTER COLUMN "store_app_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "required_apps" DROP COLUMN "bitbrowser_app_id";