/**
 * Performance seed: bulk-inserts a realistic volume into the database of DATABASE_URL so list pages, the
 * dashboard and the load test can be timed on more than a handful of rows. Placeholder rows only: no
 * containers, no phones, no files on storage (media rows point at keys that don't exist).
 *
 *   npx tsx --env-file=../../.env scripts/lib/perf-seed.ts            # seed (no-op when already seeded)
 *   npx tsx --env-file=../../.env scripts/lib/perf-seed.ts --clean    # remove exactly the seeded rows
 *   PERF_SCALE=0.1 npx tsx … scripts/lib/perf-seed.ts                 # a tenth of the volume
 *
 * NEVER against the main DB (`cloudphone`): it refuses a database named so. Everything is keyed by
 * deterministic v4-shaped uuids (md5('perf-<kind>-<n>')), users are `perf-u1..3` (password `perf-pass-123`, role user),
 * devices `perf-dev-NN` (stopped, adb ports 6000–6049, outside the allocation range), tasks carry
 * `payload.perf = true`, audit rows the username `perf-*`. Other modules can import `seedPerf()` / `cleanPerf()`.
 */
import bcrypt from 'bcryptjs';
import { sqlClient } from '../../src/db/index.js';

export const PERF_PASSWORD = 'perf-pass-123';
export const PERF_USERS = ['perf-u1', 'perf-u2', 'perf-u3'];

const SCALE = Number(process.env.PERF_SCALE ?? 1) || 1;
const n = (v: number) => Math.max(1, Math.round(v * SCALE));

export const PERF_VOLUME = {
  devices: 50, accounts: 200, personas: 30, tracked: 500, snapshotsPerTracked: 30, trackedPosts: 5000, trackedComments: 20000,
  media: 2000, contents: n(20000), publishTasks: n(50000), tasks: n(200000), logsPerTask: 5, audit: n(100000),
  comments: n(50000), commentTasks: n(20000), following: 20000, stats: 30000, notifications: n(30000),
  statusEvents: n(100000), riskEvents: n(5000), accountLogs: n(20000), ownPosts: 10000,
};

/** md5-based deterministic uuid for row <kind>-<expr>, with version 4 / variant bits so the API's uuid validation accepts it. */
const u = (kind: string, expr: string) => `overlay(overlay(md5('perf-${kind}-' || (${expr})) placing '4' from 13) placing '8' from 17)::uuid`;
/** A timestamp spread over the last `days` days, deterministic per row. */
const ago = (expr: string, days = 90) => `now() - ((((${expr})::bigint * 7919) % ${days * 1440}) * interval '1 minute')`;
/** Row `expr` of `total` in insertion order over the last `days` days, oldest first (append-only tables are
 *  physically in time order in production, so their time indexes are well correlated with the heap). */
const seq = (expr: string, total: number, days: number) => `now() - ((${total} - (${expr}))::bigint * ${days * 86400} / ${total}) * interval '1 second'`;

function statements(v: typeof PERF_VOLUME, hash: string): string[] {
  const U = (e: string) => u('user', `(((${e}) - 1) % 3) + 1`); // user 1..3 by index
  // an account of content c's user (account a belongs to user ((a-1) % 3) + 1); off = 0 first target, 1 second
  const per = Math.floor(v.accounts / 3);
  const acctOf = (c: string, off = 0) => u('acct', `3 * ((((${c}) - 1) / 3 + ${off}) % ${per}) + (((${c}) - 1) % 3) + 1`);
  return [
    `INSERT INTO users (id, username, password_hash, role, display_name)
     SELECT ${u('user', 'g')}, 'perf-u' || g, '${hash}', 'user', 'Perf user ' || g FROM generate_series(1, 3) g`,
    // devices are external phones of one INERT source (invalid apiUrl: the monitor skips them, see lib/placeholder.ts)
    `INSERT INTO device_sources (id, type, name, config) VALUES (${u('src', '1')}, 'bitbrowser', 'perf-src', '{"apiUrl":"not a url"}')`,
    `INSERT INTO instances (id, name, engine, source_id, external_id, adb_port, status, spec, created_at)
     SELECT ${u('dev', 'g')}, 'perf-dev-' || lpad(g::text, 2, '0'), 'bitbrowser', ${u('src', '1')}, 'perf-dev-' || g, 5999 + g, 'stopped',
            '{"width":720,"height":1280,"dpi":320}', ${ago('g', 120)} FROM generate_series(1, ${v.devices}) g`,
    // 45 devices assigned (one user each), 5 unassigned
    `INSERT INTO instance_grants (user_id, instance_id) SELECT ${U('g')}, ${u('dev', 'g')} FROM generate_series(1, ${v.devices - 5}) g`,
    `INSERT INTO instance_status_events (instance_id, field, "from", "to", status, at)
     SELECT ${u('dev', `(g % ${v.devices}) + 1`)}, CASE WHEN g % 2 = 0 THEN 'status' ELSE 'adb' END,
            CASE WHEN g % 2 = 0 THEN 'running' ELSE 'device' END, CASE WHEN g % 2 = 0 THEN 'stopped' ELSE NULL END,
            CASE WHEN g % 3 = 0 THEN 'running' ELSE 'stopped' END, ${seq('g', v.statusEvents, 30)} FROM generate_series(1, ${v.statusEvents}) g`,
    `INSERT INTO personas (id, owner_type, owner_id, name, description, created_by)
     SELECT ${u('persona', 'g')}, CASE WHEN g <= 6 THEN 'public' ELSE 'user' END, CASE WHEN g <= 6 THEN NULL ELSE ${U('g')} END,
            'perf persona ' || g, 'positioning ' || g, ${U('g')} FROM generate_series(1, ${v.personas}) g`,
    `INSERT INTO social_accounts (id, user_id, platform, handle, display_name, instance_id, login_status, persona_id, lang, external_id, created_at, last_checked_at, last_check_code)
     SELECT ${u('acct', 'g')}, ${U('g')}, CASE WHEN g % 4 = 0 THEN 'youtube' ELSE 'instagram' END, 'perf_acct_' || g, 'Perf account ' || g,
            CASE WHEN g % 10 = 0 THEN NULL ELSE ${u('dev', `(g % ${v.devices}) + 1`)} END,
            (ARRAY['logged_in','logged_in','logged_out','unknown'])[(g % 4) + 1], ${u('persona', `(g % ${v.personas}) + 1`)},
            CASE WHEN g % 5 = 0 THEN 'en' ELSE NULL END, (1000000 + g)::text, ${ago('g', 200)}, ${ago('g', 2)}, 'ok'
     FROM generate_series(1, ${v.accounts}) g`,
    `INSERT INTO social_account_stats (social_account_id, day, captured_at, source, followers, following, posts, views, likes, comments)
     SELECT ${u('acct', `((g - 1) % ${v.accounts}) + 1`)}, (current_date - ((g - 1) / ${v.accounts})::int), now() - ((g - 1) / ${v.accounts}) * interval '1 day',
            'device', 1000 + g, 100 + g % 50, 10 + g % 30, g % 500, g % 200, g % 40 FROM generate_series(1, ${v.stats}) g`,
    `INSERT INTO social_account_posts (social_account_id, platform, external_id, caption, permalink, published_at, likes, comments, source)
     SELECT ${u('acct', `((g - 1) % ${v.accounts}) + 1`)}, 'instagram', 'perfpost' || g, 'caption ' || g, 'https://www.instagram.com/p/perf' || g || '/',
            ${ago('g', 365)}, g % 1000, g % 50, 'device' FROM generate_series(1, ${v.ownPosts}) g`,
    `INSERT INTO social_account_following (social_account_id, handle, display_name, position, first_seen_at, last_seen_at, gone_at)
     SELECT ${u('acct', `((g - 1) % 100) + 1`)}, 'perf_follow_' || g, 'Follow ' || g, (g - 1) / 100, ${ago('g', 60)}, now(),
            CASE WHEN g % 20 = 0 THEN now() - interval '1 day' ELSE NULL END FROM generate_series(1, ${v.following}) g`,
    `INSERT INTO social_account_logs (account_id, at, action, field, from_value, to_value, message)
     SELECT ${u('acct', `((g - 1) % ${v.accounts}) + 1`)}, ${seq('g', v.accountLogs, 90)}, 'checked', 'login_status', 'unknown', 'logged_in', 'perf'
     FROM generate_series(1, ${v.accountLogs}) g`,
    `INSERT INTO tracked_accounts (id, user_id, platform, handle, profile_url, display_name, status, refresh_interval_hours, next_refresh_at, tags, favorite, created_at, last_checked_at, last_source)
     SELECT ${u('tracked', 'g')}, ${U('g')}, CASE WHEN g % 5 = 0 THEN 'youtube' ELSE 'instagram' END, 'perf_tracked_' || g,
            'https://www.instagram.com/perf_tracked_' || g || '/', 'Tracked ' || g, CASE WHEN g % 25 = 0 THEN 'paused' ELSE 'active' END,
            CASE WHEN g % 5 = 0 THEN NULL ELSE 24 END, now() + ((g % 1440) * interval '1 minute'),
            CASE WHEN g % 3 = 0 THEN ARRAY['news','perf'] ELSE '{}'::text[] END, g % 7 = 0, ${ago('g', 200)}, ${ago('g', 1)}, 'device'
     FROM generate_series(1, ${v.tracked}) g`,
    `INSERT INTO tracked_account_snapshots (tracked_account_id, captured_at, source, followers, following, posts)
     SELECT ${u('tracked', `((g - 1) % ${v.tracked}) + 1`)}, now() - ((g - 1) / ${v.tracked}) * interval '1 day', 'device', 50000 + g, 300, 1000 + g / ${v.tracked}
     FROM generate_series(1, ${v.tracked * v.snapshotsPerTracked}) g`,
    `INSERT INTO tracked_posts (id, tracked_account_id, external_id, url, title, published_at, likes, comments, source, media_type)
     SELECT ${u('tpost', 'g')}, ${u('tracked', `((g - 1) % ${v.tracked}) + 1`)}, 'perftp' || g, 'https://www.instagram.com/p/perftp' || g || '/',
            'post ' || g, ${ago('g', 120)}, g % 5000, g % 100, 'device', 'photo' FROM generate_series(1, ${v.trackedPosts}) g`,
    `INSERT INTO tracked_post_comments (tracked_post_id, tracked_account_id, external_id, author_handle, text, position, published_at)
     SELECT ${u('tpost', `((g - 1) % ${v.trackedPosts}) + 1`)}, ${u('tracked', `((((g - 1) % ${v.trackedPosts})) % ${v.tracked}) + 1`)},
            'perftc' || g, 'author' || (g % 300), 'comment text ' || g, (g - 1) / ${v.trackedPosts}, ${ago('g', 60)} FROM generate_series(1, ${v.trackedComments}) g`,
    `INSERT INTO media_assets (id, owner_type, owner_id, name, file_name, storage, file_key, file_type, mime_type, file_size, width, height, checksum, status, created_at)
     SELECT ${u('media', 'g')}, CASE WHEN g <= 500 THEN 'public' ELSE 'user' END, CASE WHEN g <= 500 THEN NULL ELSE ${U('g')} END,
            'perf media ' || g, 'perf' || g || '.jpg', 'local', 'perf/missing/' || g || '.jpg', CASE WHEN g % 10 = 0 THEN 'video' ELSE 'image' END,
            CASE WHEN g % 10 = 0 THEN 'video/mp4' ELSE 'image/jpeg' END, 100000 + g, 1080, 1080, md5('perf-media-sum-' || g), 'ready', ${ago('g', 200)}
     FROM generate_series(1, ${v.media}) g`,
    `INSERT INTO contents (id, user_id, title, body, stage, status, lang, created_by, created_at, updated_at)
     SELECT ${u('content', 'g')}, ${U('g')}, 'Perf content ' || g, 'body of perf content ' || g,
            (ARRAY['draft','ready','ready','archived'])[(g % 4) + 1],
            (ARRAY['draft','published','failed','archived','ready','scheduled','partially_published'])[(g % 7) + 1],
            'zh-CN', ${U('g')}, ${seq('g', v.contents, 365)}, ${seq('g', v.contents, 30)} FROM generate_series(1, ${v.contents}) g`,
    // targets: the account with the same user (account index ≡ content index mod 3) — 1 or 2 per content
    `INSERT INTO content_targets (content_id, account_id, position)
     SELECT ${u('content', 'g')}, ${acctOf('g')}, 0 FROM generate_series(1, ${v.contents}) g`,
    `INSERT INTO content_targets (content_id, account_id, position)
     SELECT ${u('content', 'g')}, ${acctOf('g', 1)}, 1 FROM generate_series(1, ${v.contents}) g WHERE g % 2 = 0`,
    // media: a public asset per content, a second one (same owner) for every third
    `INSERT INTO content_media (content_id, asset_id, position)
     SELECT ${u('content', 'g')}, ${u('media', `((g - 1) % 500) + 1`)}, 0 FROM generate_series(1, ${v.contents}) g`,
    `INSERT INTO content_media (content_id, asset_id, position)
     SELECT ${u('content', 'g')}, ${u('media', `502 + 3 * (((g - 1) / 3) % 498) + ((g - 1) % 3)`)}, 1 FROM generate_series(1, ${v.contents}) g WHERE g % 3 = 0`,
    // publish tasks: task k is for content ((k-1) % contents)+1 and its first target; only the first round of a
    // content can be unfinished (one unfinished per content + account)
    `INSERT INTO publish_tasks (id, user_id, content_id, account_id, platform, title, caption, media_ids, scheduled_at, status, method, attempt_no, max_attempts, task_id, error_code, published_at, created_by, created_at, updated_at, post_type, lang)
     SELECT ${u('pt', 'g')}, ${U(`((g - 1) % ${v.contents}) + 1`)}, ${u('content', `((g - 1) % ${v.contents}) + 1`)},
            ${acctOf(`((g - 1) % ${v.contents}) + 1`)}, 'instagram', 'Perf content ' || g, 'caption ' || g,
            ARRAY[${u('media', `((g - 1) % 500) + 1`)}],
            ${ago('g', 120)} + interval '30 days',
            CASE WHEN g <= ${v.contents} AND g % 10 = 0 THEN 'scheduled' WHEN g <= ${v.contents} AND g % 10 = 5 THEN 'awaiting_operator'
                 ELSE (ARRAY['published','published','failed','cancelled'])[(g % 4) + 1] END,
            CASE WHEN g % 3 = 0 THEN 'manual' ELSE 'device' END, 1, 1, ${u('task', 'g')},
            CASE WHEN g % 4 = 2 THEN 'publish.device_offline' ELSE NULL END,
            CASE WHEN g % 4 IN (0, 1) THEN ${ago('g', 120)} ELSE NULL END, ${U(`((g - 1) % ${v.contents}) + 1`)}, ${seq('g', v.publishTasks, 120)}, ${seq('g', v.publishTasks, 60)},
            (ARRAY['feed','feed','reel','story'])[(g % 4) + 1], 'zh-CN'
     FROM generate_series(1, ${v.publishTasks}) g`,
    `INSERT INTO publish_logs (publish_task_id, at, level, message, attempt_no)
     SELECT ${u('pt', `((g - 1) % ${v.publishTasks}) + 1`)}, ${ago('g', 120)}, 'info', 'perf log line ' || g, 1 FROM generate_series(1, ${v.publishTasks * 2}) g`,
    // tasks: the first publishTasks are the publish rounds above, the rest a mix of device / device-less types
    `INSERT INTO tasks (id, type, instance_id, instance_name, status, error, error_code, created_by, created_at, started_at, finished_at, updated_at, ref_type, ref_id, payload, attempts, max_attempts, run_at)
     SELECT ${u('task', 'g')},
            CASE WHEN g <= ${v.publishTasks} THEN 'publish' ELSE (ARRAY['tracked-refresh','account-device-check','feed-collect','media-process','start','stop','install-apk','account-following'])[(g % 8) + 1] END,
            CASE WHEN g > ${v.publishTasks} AND g % 8 IN (1, 2, 4, 5, 6, 7) THEN ${u('dev', `(g % ${v.devices}) + 1`)} ELSE NULL END,
            CASE WHEN g > ${v.publishTasks} AND g % 8 IN (1, 2, 4, 5, 6, 7) THEN 'perf-dev-' || lpad(((g % ${v.devices}) + 1)::text, 2, '0') ELSE NULL END,
            CASE WHEN g % 50 = 0 THEN 'failed' WHEN g % 97 = 0 THEN 'cancelled' WHEN g % 499 = 0 THEN 'scheduled' ELSE 'success' END,
            CASE WHEN g % 50 = 0 THEN 'perf failure' ELSE NULL END, CASE WHEN g % 50 = 0 THEN 'task.perf' ELSE NULL END,
            CASE WHEN g % 4 = 0 THEN NULL ELSE ${U('g')} END, ${seq('g', v.tasks, 90)}, ${seq('g', v.tasks, 90)}, ${seq('g', v.tasks, 90)}, ${seq('g', v.tasks, 90)},
            CASE WHEN g <= ${v.publishTasks} THEN 'publish_task' WHEN g % 8 = 0 THEN 'tracked_account' WHEN g % 8 IN (1, 2, 7) THEN 'social_account' ELSE NULL END,
            CASE WHEN g <= ${v.publishTasks} THEN ${u('pt', 'g')} WHEN g % 8 = 0 THEN ${u('tracked', `(g % ${v.tracked}) + 1`)}
                 WHEN g % 8 IN (1, 2, 7) THEN ${u('acct', `(g % ${v.accounts}) + 1`)} ELSE NULL END,
            '{"perf":true}'::jsonb, 1, 1, ${seq('g', v.tasks, 90)}
     FROM generate_series(1, ${v.tasks}) g`,
    `INSERT INTO task_logs (task_id, ts, level, message)
     SELECT ${u('task', 't')}, ${seq('t', v.tasks, 90)} + k * interval '1 second', 'info', 'perf log ' || t || '.' || k
     FROM generate_series(1, ${v.tasks}) t CROSS JOIN generate_series(1, ${v.logsPerTask}) k ORDER BY t, k`,
    `INSERT INTO audit_logs (at, user_id, username, action, target, target_id, method, path, status, ok, ip, detail)
     SELECT ${seq('g', v.audit, 90)}, ${U('g')}, 'perf-u' || (((g - 1) % 3) + 1),
            (ARRAY['content.update','publish.distribute','social.account_sync','media.upload','tracked.sync'])[(g % 5) + 1],
            'perf target ' || g, (g)::text, 'POST', '/api/perf/' || g, 200, true, '127.0.0.1', '{}'::jsonb FROM generate_series(1, ${v.audit}) g`,
    `INSERT INTO comments (id, user_id, account_id, platform, source, external_id, external_post_id, author_name, author_handle, text, like_count, published_at, status, created_at)
     SELECT ${u('cmt', 'g')}, ${U(`((g - 1) % ${v.accounts}) + 1`)}, ${u('acct', `((g - 1) % ${v.accounts}) + 1`)}, 'instagram', 'device',
            'perfc' || g, 'perfpost' || (((g - 1) / ${v.accounts}) % 50), 'Author ' || (g % 700), 'author' || (g % 700), 'comment ' || g, g % 30,
            ${seq('g', v.comments, 90)}, (ARRAY['new','read','replied','hidden','ignored'])[(g % 5) + 1], ${seq('g', v.comments, 90)}
     FROM generate_series(1, ${v.comments}) g`,
    `INSERT INTO comment_tasks (user_id, account_id, comment_id, platform, text, text_hash, status, method, scheduled_at, round, author_id, author_name, sent_at, created_at, updated_at)
     SELECT ${U(`((g - 1) % ${v.accounts}) + 1`)}, ${u('acct', `((g - 1) % ${v.accounts}) + 1`)}, ${u('cmt', 'g')}, 'instagram', 'reply ' || g, md5('reply ' || g),
            (ARRAY['draft','sent','sent','failed','scheduled'])[(g % 5) + 1], 'device', ${ago('g', 60)}, 1,
            ${U(`((g - 1) % ${v.accounts}) + 1`)}, 'perf-u' || ((((g - 1) % ${v.accounts})) % 3 + 1),
            CASE WHEN g % 5 IN (1, 2) THEN ${ago('g', 60)} ELSE NULL END, ${seq('g', v.commentTasks, 60)}, ${seq('g', v.commentTasks, 30)}
     FROM generate_series(1, ${v.commentTasks}) g`,
    `INSERT INTO notifications (user_id, kind, severity, params, ref_type, ref_id, read_at, created_at)
     SELECT ${U('g')}, (ARRAY['device.down','publish.failed','task.failed'])[(g % 3) + 1], 'error', '{"name":"perf"}'::jsonb, 'instance',
            ${u('dev', `(g % ${v.devices}) + 1`)}, CASE WHEN g % 4 = 0 THEN NULL ELSE now() END, ${seq('g', v.notifications, 60)}
     FROM generate_series(1, ${v.notifications}) g`,
    `INSERT INTO risk_events (at, instance_id, instance_name, social_account_id, source, code, detail)
     SELECT ${seq('g', v.riskEvents, 80)}, ${u('dev', `(g % ${v.devices}) + 1`)}, 'perf-dev-' || lpad(((g % ${v.devices}) + 1)::text, 2, '0'),
            ${u('acct', `(g % ${v.accounts}) + 1`)}, (ARRAY['collector','account_check','feed'])[(g % 3) + 1],
            (ARRAY['tracked.collector_timeout','account_check.logged_out','feed.timeout'])[(g % 3) + 1], 'perf' FROM generate_series(1, ${v.riskEvents}) g`,
  ];
}

export async function isSeeded(): Promise<boolean> {
  const [r] = await sqlClient`SELECT count(*)::int AS c FROM users WHERE username = 'perf-u1'`;
  return (r?.c ?? 0) > 0;
}

function assertNotMain() {
  const dbName = new URL(process.env.DATABASE_URL ?? '').pathname.slice(1);
  if (!dbName || dbName === 'cloudphone') throw new Error(`perf-seed refuses database "${dbName || '?'}": use a temporary database`);
}

export async function seedPerf(log = console.log): Promise<boolean> {
  assertNotMain();
  if (await isSeeded()) { log('perf seed: already present (use --clean first to reseed)'); return false; }
  const hash = await bcrypt.hash(PERF_PASSWORD, 10);
  const t0 = Date.now();
  await sqlClient.begin(async (tx) => {
    for (const s of statements(PERF_VOLUME, hash)) {
      const t = Date.now();
      const r = await tx.unsafe(s);
      log(`  ${s.match(/INSERT INTO (\w+)/)?.[1]}: ${r.count} rows (${Date.now() - t} ms)`);
    }
  });
  await sqlClient.unsafe('ANALYZE');
  log(`perf seed done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return true;
}

export async function cleanPerf(log = console.log): Promise<void> {
  assertNotMain();
  await sqlClient.begin(async (tx) => {
    // tasks/audit have no FK to users; media of public scope and devices neither cascade from the users
    await tx.unsafe(`DELETE FROM tasks WHERE payload->>'perf' = 'true'`);
    await tx.unsafe(`DELETE FROM audit_logs WHERE username LIKE 'perf-%'`);
    await tx.unsafe(`DELETE FROM users WHERE username = ANY($1)`, [PERF_USERS]);
    await tx.unsafe(`DELETE FROM media_assets WHERE file_key LIKE 'perf/missing/%'`);
    await tx.unsafe(`DELETE FROM personas WHERE name LIKE 'perf persona %'`);
    await tx.unsafe(`DELETE FROM instances WHERE name LIKE 'perf-dev-%'`);
    await tx.unsafe(`DELETE FROM device_sources WHERE name = 'perf-src'`);
  });
  log('perf seed removed');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    if (process.argv.includes('--clean')) await cleanPerf();
    else await seedPerf();
    await sqlClient.end();
  })().catch(async (e) => { console.error(e); await sqlClient.end(); process.exit(1); });
}
