-- 话术库 removed (owner decision 2026-11-18): templates are only the 范例 of personas now, so every template needs a
-- persona (API: template.persona_required). Data only, no column change: templates without a persona are deleted
-- (idempotent; a rerun deletes nothing new). Replies keep working: comment_tasks.template_id has no foreign key.
DELETE FROM "comment_templates" WHERE "persona_id" IS NULL;
