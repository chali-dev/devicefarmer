-- drop_legacy (owner decision 2026-11-18: not in production yet, so LEGACY tables / columns / settings are dropped now
-- instead of after an expand/contract release). Data first: leftovers of removed states are converted so a backup of an
-- older release (导入) still comes up consistent; the removed TS data migrations are no longer needed after this.

-- comment replies: no approval step, no test mode
UPDATE "comment_tasks" SET "status" = 'scheduled', "updated_at" = now()
  WHERE "status" = 'approved' AND "task_id" IN (SELECT "id" FROM "tasks" WHERE "status" IN ('pending', 'scheduled', 'running'));--> statement-breakpoint
UPDATE "comment_tasks" SET "status" = 'draft', "round" = "round" + 1, "task_id" = NULL, "error" = NULL, "error_code" = NULL, "updated_at" = now()
  WHERE "status" IN ('approved', 'pending_review');--> statement-breakpoint
UPDATE "comment_tasks" SET "status" = 'cancelled', "error_code" = CASE WHEN "status" = 'dry_run' THEN 'comment.test_mode_removed' ELSE coalesce("error_code", 'comment.cancelled') END, "updated_at" = now()
  WHERE "status" IN ('dry_run', 'rejected');--> statement-breakpoint
-- publish: no test mode
UPDATE "publish_tasks" SET "status" = 'cancelled', "error_code" = 'publish.test_mode_removed', "updated_at" = now() WHERE "status" = 'dry_run';--> statement-breakpoint
-- media: public media is always visible
UPDATE "media_assets" SET "status" = 'ready', "updated_at" = now() WHERE "status" = 'disabled';--> statement-breakpoint
-- tracked accounts: the free-text category becomes a tag (as tracked-category-data-migration.ts did)
UPDATE "tracked_accounts" SET "tags" = (
    SELECT coalesce(array_agg(DISTINCT t), '{}') FROM unnest("tags" || ARRAY[left(lower(trim("category")), 32)]) AS t
  ), "updated_at" = now()
  WHERE "category" IS NOT NULL AND trim("category") <> '' AND cardinality("tags") < 20;--> statement-breakpoint
-- removed task types (official APIs, daily AI drafts): deleted with their logs (no handler runs them any more)
DELETE FROM "tasks" WHERE "type" IN ('persona-drafts', 'account-drafts', 'account-stats', 'comment-sync', 'social-account-check');--> statement-breakpoint
-- settings rows / fields nobody reads any more
DELETE FROM "settings" WHERE "key" IN ('platform.apps', 'content.languages', 'publish.retry');--> statement-breakpoint
UPDATE "settings" SET "value" = "value" - 'enabled' - 'hour' WHERE "key" = 'ai';--> statement-breakpoint
UPDATE "settings" SET "value" = "value" - 'testMode' - 'requireApproval' WHERE "key" = 'comments.rules';--> statement-breakpoint
UPDATE "settings" SET "value" = "value" - 'testMode' - 'enabled' WHERE "key" = 'publish.device';--> statement-breakpoint

ALTER TABLE "comment_tasks" DROP CONSTRAINT IF EXISTS "comment_tasks_reviewer_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "personas" DROP CONSTRAINT IF EXISTS "personas_draft_owner_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "social_accounts" DROP CONSTRAINT IF EXISTS "social_accounts_group_id_social_account_groups_id_fk";--> statement-breakpoint
DROP TABLE "comment_sync_states" CASCADE;--> statement-breakpoint
DROP TABLE "platform_connections" CASCADE;--> statement-breakpoint
DROP TABLE "social_account_groups" CASCADE;--> statement-breakpoint
DROP INDEX IF EXISTS "contents_user_category_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "social_accounts_group_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "tracked_accounts_user_category_idx";--> statement-breakpoint
DROP INDEX "comment_tasks_one_active_idx";--> statement-breakpoint
DROP INDEX "comment_tasks_tracked_one_active_idx";--> statement-breakpoint
DROP INDEX "comment_templates_kind_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "comment_tasks_one_active_idx" ON "comment_tasks" USING btree ("comment_id") WHERE status not in ('failed', 'cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX "comment_tasks_tracked_one_active_idx" ON "comment_tasks" USING btree ("tracked_comment_id") WHERE tracked_comment_id is not null and status not in ('failed', 'cancelled');--> statement-breakpoint
CREATE INDEX "comment_templates_kind_idx" ON "comment_templates" USING btree ("kind","persona_id");--> statement-breakpoint
ALTER TABLE "comment_tasks" DROP COLUMN "reviewer_id";--> statement-breakpoint
ALTER TABLE "comment_tasks" DROP COLUMN "reviewer_name";--> statement-breakpoint
ALTER TABLE "comment_tasks" DROP COLUMN "reviewed_at";--> statement-breakpoint
ALTER TABLE "comment_tasks" DROP COLUMN "review_note";--> statement-breakpoint
ALTER TABLE "comment_templates" DROP COLUMN "persona";--> statement-breakpoint
ALTER TABLE "contents" DROP COLUMN "category";--> statement-breakpoint
ALTER TABLE "media_assets" DROP COLUMN "disable_on_ready";--> statement-breakpoint
ALTER TABLE "personas" DROP COLUMN "draft_enabled";--> statement-breakpoint
ALTER TABLE "personas" DROP COLUMN "drafts_per_day";--> statement-breakpoint
ALTER TABLE "personas" DROP COLUMN "draft_owner_id";--> statement-breakpoint
ALTER TABLE "social_accounts" DROP COLUMN "group_id";--> statement-breakpoint
ALTER TABLE "social_accounts" DROP COLUMN "ai_drafts_enabled";--> statement-breakpoint
ALTER TABLE "social_accounts" DROP COLUMN "ai_drafts_per_day";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "backoff_ms";--> statement-breakpoint
ALTER TABLE "tracked_accounts" DROP COLUMN "category";
