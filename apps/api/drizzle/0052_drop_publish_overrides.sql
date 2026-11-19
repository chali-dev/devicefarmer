-- No per-account text overrides (owner 2026-11-19): every account gets the content's text. A publish task's caption is
-- what was (or will be) posted, so the stored hashtags of older rows are folded into it, as they were sent
-- (caption, blank line, "#tag #tag"), before the column goes.
UPDATE "publish_tasks" SET "caption" = concat_ws(E'\n\n', nullif(regexp_replace("caption", '^\s+|\s+$', '', 'g'), ''), (SELECT string_agg('#' || h, ' ' ORDER BY i) FROM unnest("hashtags") WITH ORDINALITY AS t(h, i)))
  WHERE cardinality("hashtags") > 0;--> statement-breakpoint
ALTER TABLE "publish_tasks" DROP COLUMN "hashtags";
