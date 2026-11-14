CREATE TABLE "library_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package" text NOT NULL,
	"version_name" text,
	"version_code" text NOT NULL,
	"files" jsonb NOT NULL,
	"preinstall" boolean DEFAULT false NOT NULL,
	"source_instance" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_pkg_version" UNIQUE("package","version_code")
);
