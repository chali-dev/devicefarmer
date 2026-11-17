ALTER TABLE "media_categories" ADD COLUMN "description" text;--> statement-breakpoint
-- Case-duplicate names per owner ("Travel" / "travel") are merged before the case-insensitive unique index: per owner and
-- lower(name) the row with the lowest (sort, created_at, id) is kept, the others' assets move to it, then they are deleted.
WITH ranked AS (
  SELECT id, first_value(id) OVER (PARTITION BY coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name) ORDER BY sort, created_at, id) AS keep
  FROM media_categories
), dup AS (SELECT id, keep FROM ranked WHERE id <> keep)
UPDATE media_assets a SET category_id = dup.keep FROM dup WHERE a.category_id = dup.id;--> statement-breakpoint
WITH ranked AS (
  SELECT id, first_value(id) OVER (PARTITION BY coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name) ORDER BY sort, created_at, id) AS keep
  FROM media_categories
)
DELETE FROM media_categories c USING ranked r WHERE c.id = r.id AND r.id <> r.keep;--> statement-breakpoint
CREATE UNIQUE INDEX "media_categories_owner_name_lower" ON "media_categories" USING btree (coalesce("owner_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
-- Implied by the new index (owner_id is null exactly for public rows).
ALTER TABLE "media_categories" DROP CONSTRAINT "media_categories_owner_name";
