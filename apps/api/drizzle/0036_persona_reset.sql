-- 人设整合 (owner decision 2026-11-18): every persona and its examples are wiped; test personas are created again
-- (scripts/demo-seed-personas.ts). Data only, no column changes: personas.brief keeps its name and now holds the new
-- style shape (PersonaStyle), so an old colour still selects every column it knows during a blue-green switch.
-- The legacy texts/groups are cleared too, so persona-data-migration.ts / social-group-data-migration.ts (run by
-- db:migrate after this) cannot re-create personas from them.
UPDATE "social_accounts" SET "persona_id" = NULL WHERE "persona_id" IS NOT NULL;--> statement-breakpoint
UPDATE "social_accounts" SET "group_id" = NULL WHERE "group_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "comment_templates" WHERE "persona_id" IS NOT NULL;--> statement-breakpoint
UPDATE "comment_templates" SET "persona" = NULL WHERE "persona" IS NOT NULL;--> statement-breakpoint
DELETE FROM "personas";
