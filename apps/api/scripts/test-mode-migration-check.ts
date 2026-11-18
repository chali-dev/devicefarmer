/**
 * Data migration check for src/db/test-mode-removal-migration.ts (owner decision 2026-11-18: no test mode, draft first)
 * against the real DB of the running environment and the real API (to schedule a migrated draft). Seeds legacy
 * `dry_run` rows directly, as the former test mode wrote them:
 * - a reply rehearsal on a comment → `draft` again (round + 1, task / method / hand-over / error cleared, screenshot kept),
 *   comment log `test_mode_removed`; scheduling it afterwards (POST …/submit) creates the task of the NEW round;
 * - two rehearsals on one comment → the newest becomes the draft, the older one `cancelled` (comment.test_mode_removed),
 *   since a draft blocks another reply (partial unique index);
 * - a rehearsal on a comment that already has another active reply (awaiting_operator) → `cancelled`;
 * - a rehearsal of a comment directly under a post (no comment id) → draft;
 * - tracked comment with another active (scheduled) reply → cancelled; a tracked comment without one → draft;
 * - a publish rehearsal → `cancelled` (publish.test_mode_removed) + publish_logs row; 重试 (retry) schedules it again;
 * - rows that are not dry_run are untouched.
 * Runs the migration twice (second run: nothing), then the real `db:migrate` (also a no-op for these rows). Cleans up.
 * Usage (from apps/api, API running): E2E_API=http://127.0.0.1:<port> API_PORT=<port> npx tsx --env-file=../../.env scripts/test-mode-migration-check.ts
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { sqlClient as sql } from '../src/db/index.js';
import { migrateTestModeRemoval } from '../src/db/test-mode-removal-migration.js';
import { withCaptcha } from './lib/login.js';

const API = process.env.E2E_API ?? `http://127.0.0.1:${process.env.API_PORT ?? 3000}`;
let failed = 0;
let passed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (ok) passed++; else failed++;
};
async function http(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, body: json, text };
}
const login = async () => {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await withCaptcha(API, { username: process.env.ADMIN_USERNAME!, password: process.env.ADMIN_PASSWORD! })) });
  return (await r.json()).token as string;
};

const tag = randomBytes(3).toString('hex');
const one = async <T>(q: Promise<T[]>) => (await q)[0]!;
type Row = { id: string };
const uid = (await one(sql<Row[]>`insert into users (username, password_hash, role) values (${`tmm${tag}`}, 'x', 'user') returning id`)).id;
const T = await login();
try {
  const acc = (await one(sql<Row[]>`insert into social_accounts (user_id, platform, handle) values (${uid}, 'instagram', ${`tmm_${tag}`}) returning id`)).id;
  const comment = async (n: string) => (await one(sql<Row[]>`insert into comments (user_id, account_id, platform, source, external_id, text, author_name)
    values (${uid}, ${acc}, 'instagram', 'manual', ${`manual:${tag}:${n}`}, ${`hello ${n}`}, ${n}) returning id`)).id;
  const [c1, c2, c3] = [await comment('c1'), await comment('c2'), await comment('c3')];
  const post = (await one(sql<Row[]>`insert into social_account_posts (social_account_id, platform, external_id) values (${acc}, 'instagram', ${`3${Date.now()}${tag.length}`}) returning id`)).id;
  const ta = (await one(sql<Row[]>`insert into tracked_accounts (user_id, platform, handle, profile_url) values (${uid}, 'instagram', ${`tmt_${tag}`}, ${`https://www.instagram.com/tmt_${tag}/`}) returning id`)).id;
  const tp = (await one(sql<Row[]>`insert into tracked_posts (tracked_account_id, source, external_id) values (${ta}, 'device', ${`tp${tag}`}) returning id`)).id;
  const tk = async (n: string) => (await one(sql<Row[]>`insert into tracked_post_comments (tracked_post_id, tracked_account_id, external_id, text, author_handle)
    values (${tp}, ${ta}, ${`tk:${tag}:${n}`}, ${`t ${n}`}, ${n}) returning id`)).id;
  const [k1, k2] = [await tk('k1'), await tk('k2')];
  const fakeTask = '00000000-0000-4000-8000-000000000001';
  const reply = async (o: { status: string; commentId?: string | null; postId?: string | null; trackedCommentId?: string | null; ago: number; round?: number }) => (await one(sql<Row[]>`
    insert into comment_tasks (user_id, account_id, comment_id, post_id, tracked_post_id, tracked_comment_id, platform, text, text_hash, status, method, round, task_id,
      handed_at, submitted_at, error_code, evidence, created_at)
    values (${uid}, ${acc}, ${o.commentId ?? null}, ${o.postId ?? null}, ${o.trackedCommentId ? tp : null}, ${o.trackedCommentId ?? null}, 'instagram', ${`text ${randomBytes(2).toString('hex')}`},
      ${randomBytes(16).toString('hex')}, ${o.status}, ${o.status === 'dry_run' ? 'device' : 'manual'}, ${o.round ?? 1}, ${o.status === 'dry_run' ? fakeTask : null},
      now(), now(), ${o.status === 'dry_run' ? 'comment.test_mode' : null},
      ${o.status === 'dry_run' ? JSON.stringify({ at: new Date().toISOString(), storage: 'local', key: `evidence/replies/x-${tag}.png`, inputText: 'x' }) : null}::jsonb,
      now() - ${`${o.ago} seconds`}::interval) returning id`)).id;
  const rAlone = await reply({ status: 'dry_run', commentId: c1, ago: 50 });
  const rOld = await reply({ status: 'dry_run', commentId: c2, ago: 40 });
  const rNew = await reply({ status: 'dry_run', commentId: c2, ago: 30 });
  const rActive = await reply({ status: 'awaiting_operator', commentId: c3, ago: 25 });
  const rBlocked = await reply({ status: 'dry_run', commentId: c3, ago: 20 });
  const rPost = await reply({ status: 'dry_run', postId: post, ago: 15, round: 2 });
  await reply({ status: 'scheduled', trackedCommentId: k1, ago: 12 });
  const rTk1 = await reply({ status: 'dry_run', trackedCommentId: k1, ago: 10 });
  const rTk2 = await reply({ status: 'dry_run', trackedCommentId: k2, ago: 5 });
  const content = (await one(sql<Row[]>`insert into contents (user_id, title) values (${uid}, ${`tmm content ${tag}`}) returning id`)).id;
  const pub = (await one(sql<Row[]>`insert into publish_tasks (user_id, content_id, account_id, platform, status, method, error_code, attempt_no, scheduled_at)
    values (${uid}, ${content}, ${acc}, 'instagram', 'dry_run', 'device', 'publish.test_mode', 1, now() - interval '1 hour') returning id`)).id;
  const pubOk = (await one(sql<Row[]>`insert into publish_tasks (user_id, content_id, account_id, platform, status, attempt_no)
    values (${uid}, ${content}, ${acc}, 'instagram', 'failed', 1) returning id`)).id;
  const ids = [rAlone, rOld, rNew, rActive, rBlocked, rPost, rTk1, rTk2, pub, pubOk];

  const m1 = await migrateTestModeRemoval(sql, () => undefined, { ids });
  check('first run: 4 replies back to draft, 3 cancelled, 1 publish task cancelled', m1.drafts === 4 && m1.cancelledReplies === 3 && m1.publish === 1, m1);
  const st = async (id: string) => one(sql<{ status: string; round: number; task_id: string | null; method: string | null; handed_at: Date | null; submitted_at: Date | null; error_code: string | null; evidence: unknown }[]>`
    select status, round, task_id, method, handed_at, submitted_at, error_code, evidence from comment_tasks where id = ${id}`);
  const a = await st(rAlone);
  check('rehearsal alone → draft: round 2, task / method / handed / submitted / code cleared, screenshot kept',
    a.status === 'draft' && a.round === 2 && a.task_id === null && a.method === null && a.handed_at === null && a.submitted_at === null && a.error_code === null && !!a.evidence, a);
  const [o, n] = [await st(rOld), await st(rNew)];
  check('two rehearsals on one comment → the newest is the draft, the older cancelled (comment.test_mode_removed)',
    n.status === 'draft' && o.status === 'cancelled' && o.error_code === 'comment.test_mode_removed', { o, n });
  const [b, act] = [await st(rBlocked), await st(rActive)];
  check('comment with another active reply → the rehearsal is cancelled, the active one untouched', b.status === 'cancelled' && b.error_code === 'comment.test_mode_removed' && act.status === 'awaiting_operator', { b, act });
  const p = await st(rPost);
  check('post comment rehearsal (no comment id) → draft, round 3', p.status === 'draft' && p.round === 3, p);
  const [t1, t2] = [await st(rTk1), await st(rTk2)];
  check('tracked comment with a scheduled reply → cancelled; tracked comment alone → draft', t1.status === 'cancelled' && t2.status === 'draft', { t1, t2 });
  const logs = await sql<{ id: string; action: string; level: string; data: any }[]>`select comment_task_id as id, action, level, data from comment_logs where comment_task_id = any(${ids}::uuid[])`;
  check('one comment log per migrated reply (action test_mode_removed, from/to)', logs.length === 7 && logs.every((l) => l.action === 'test_mode_removed' && l.data?.from === 'dry_run')
    && logs.find((l) => l.id === rOld)?.data?.to === 'cancelled' && logs.find((l) => l.id === rOld)?.level === 'warn', logs);
  const pr = await one(sql<{ status: string; error_code: string | null }[]>`select status, error_code from publish_tasks where id = ${pub}`);
  const pOk = await one(sql<{ status: string }[]>`select status from publish_tasks where id = ${pubOk}`);
  const plog = await sql<{ message: string }[]>`select message from publish_logs where publish_task_id = ${pub}`;
  check('publish rehearsal → cancelled (publish.test_mode_removed) + publish log; a failed task untouched',
    pr.status === 'cancelled' && pr.error_code === 'publish.test_mode_removed' && plog.length === 1 && /test mode removed/.test(plog[0]!.message) && pOk.status === 'failed', { pr, plog, pOk });

  const m2 = await migrateTestModeRemoval(sql, () => undefined, { ids });
  const logs2 = await sql`select 1 from comment_logs where comment_task_id = any(${ids}::uuid[])`;
  const plog2 = await sql`select 1 from publish_logs where publish_task_id = ${pub}`;
  check('second run: nothing to do, no new logs', m2.drafts === 0 && m2.cancelledReplies === 0 && m2.publish === 0 && logs2.length === 7 && plog2.length === 1, { m2, logs: logs2.length });
  const out = execFileSync('npx', ['tsx', '--env-file=../../.env', 'src/db/migrate.ts'], { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const dry = await sql`select 1 from comment_tasks where status = 'dry_run' union all select 1 from publish_tasks where status = 'dry_run'`;
  check('db:migrate runs it too: succeeds, no dry_run rows left anywhere', /migrations applied/.test(out) && dry.length === 0, out.slice(-300));

  // the migrated draft can be edited and scheduled: the new round's task gets a fresh key
  let r = await http('PATCH', `/api/comment-replies/${rAlone}`, T, { text: `edited after the migration ${tag}` });
  const edited = r.status === 200 && r.body.reply.status === 'draft';
  r = await http('POST', `/api/comment-replies/${rAlone}/submit`, T, { scheduledAt: new Date(Date.now() + 86_400_000).toISOString() });
  const task = r.body?.reply?.taskId ? await one(sql<{ idempotency_key: string; status: string }[]>`select idempotency_key, status from tasks where id = ${r.body.reply.taskId}`) : null;
  check('migrated draft: edit (PATCH) + 排程 → scheduled, task key comment-reply:<id>:2 (the rehearsal round stays unused)',
    edited && r.status === 200 && r.body.reply.status === 'scheduled' && task?.idempotency_key === `comment-reply:${rAlone}:2` && task.status === 'scheduled', r.text.slice(0, 300));
  if (r.body?.reply?.id) await http('POST', `/api/comment-replies/${rAlone}/cancel`, T);
  r = await http('POST', `/api/publish/tasks/${pub}/retry`, T, { scheduledAt: new Date(Date.now() + 86_400_000).toISOString() });
  check('migrated publish task: 重试 schedules it again (new round, scheduled)', r.status === 202 && r.body.task.status === 'scheduled' && r.body.task.attemptNo === 2, r.text.slice(0, 300));
  if (r.status === 202) await http('POST', `/api/publish/tasks/${pub}/cancel`, T);
} catch (err) {
  check(`unexpected error: ${(err as Error).stack}`, false);
} finally {
  await sql`update tasks set status = 'cancelled', finished_at = now() where status in ('pending', 'scheduled') and created_by = ${uid}`;
  await sql`delete from users where id = ${uid}`;
  const left = await sql`select 1 from social_accounts where handle = ${`tmm_${tag}`}`;
  check('cleanup: user and everything seeded removed', left.length === 0);
  console.log(`\n${passed}/${passed + failed} checks passed`);
  await sql.end();
  process.exit(failed ? 1 : 0);
}
