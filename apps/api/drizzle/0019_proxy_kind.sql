ALTER TABLE "proxies" ADD COLUMN "kind" text DEFAULT 'static' NOT NULL;--> statement-breakpoint
CREATE INDEX "proxies_kind_idx" ON "proxies" USING btree ("kind");