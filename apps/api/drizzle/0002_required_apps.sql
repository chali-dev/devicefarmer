CREATE TABLE "required_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package" text NOT NULL,
	"name" text NOT NULL,
	"bitbrowser_app_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "required_apps_package_unique" UNIQUE("package")
);
