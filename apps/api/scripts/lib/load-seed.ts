/**
 * Volume seed for scripts/load-check.ts (压测), written straight into the DB of the API under test (same .env /
 * DATABASE_URL as that API). Everything carries the run's tag (`ld-<tag>` / `ld_<tag>_…`) so `cleanupLoad` removes
 * exactly it. The rows look like what the product writes (finished tasks with logs, publish history, threads of
 * comments, 90 days of account stats, tracked snapshots, notifications), so the list endpoints have realistic work.
 *
 * Devices are placeholders (status stopped, adb ports 6100+ that nothing listens on): no container, the monitor
 * leaves them alone, and a publish run on one of their accounts fails at once (device offline in the DB).
 *
 * Volumes per LOAD_SCALE s (users fixed): devices min(50, 5 s) · social accounts 20 s · stats 90 days per account ·
 * media 50 s · contents 500 s (1 medium, 1 target) · publish tasks 1000 s (finished) · comments 2000 s (20 % replies
 * in threads) · tracked accounts 100 s × 30 snapshots + 5 posts · tasks 2000 s × 3 logs · notifications 2000 s.
 */
import { randomBytes } from 'node:crypto';
import { inArray, like, or, sql } from 'drizzle-orm';
import { db, schema } from '../../src/db/index.js';

export interface LoadSeed {
  devices: { id: string; userId: string }[];
  accounts: { id: string; userId: string; instanceId: string | null }[];
  publicMedia: string[];
  counts: Record<string, number>;
}

const DAY = 86_400_000;
const pick = <T>(a: readonly T[], i: number) => a[i % a.length]!;
async function chunked<T>(rows: T[], insert: (part: T[]) => Promise<unknown>, size = 1000) {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

export async function seedLoad(tag: string, scale: number, adminId: string, userIds: string[]): Promise<LoadSeed> {
  const now = Date.now();
  const U = userIds.length;
  const counts: Record<string, number> = {};

  // ------------------------------------------------------------ devices (placeholders), one user per phone
  const D = Math.min(50, 5 * scale);
  const devs = await db.insert(schema.instances).values(Array.from({ length: D }, (_, i) => ({
    name: `ld-${tag}-dev-${i}`, image: 'none', adbPort: 6100 + i, status: 'stopped' as const, adbState: null,
    bootCompleted: false, spec: { width: 720, height: 1280, dpi: 320 },
  }))).returning({ id: schema.instances.id });
  const devices = devs.map((d, i) => ({ id: d.id, userId: userIds[i % U]! }));
  await db.insert(schema.instanceGrants).values(devices.map((d) => ({ userId: d.userId, instanceId: d.id })));
  counts.devices = D;

  // ------------------------------------------------------------ social accounts (the first D on the phones) + 90 days of stats
  const A = 20 * scale;
  const accRows = await db.insert(schema.socialAccounts).values(Array.from({ length: A }, (_, j) => ({
    userId: userIds[j % U]!, platform: 'instagram', handle: `ld_${tag}_${j}`, displayName: `Load ${j}`,
    profileUrl: `https://www.instagram.com/ld_${tag}_${j}/`, externalId: String(9_000_000 + j),
    // device j belongs to user j % U, like account j
    instanceId: j < D ? devices[j]!.id : null, loginStatus: 'logged_in' as const, lastCheckedAt: new Date(now - (j % 24) * 3600_000), lastCheckCode: 'ok',
  }))).returning({ id: schema.socialAccounts.id, userId: schema.socialAccounts.userId, instanceId: schema.socialAccounts.instanceId });
  counts.socialAccounts = A;
  const stats = accRows.flatMap((a, j) => Array.from({ length: 90 }, (_, d) => ({
    socialAccountId: a.id, day: new Date(now - (89 - d) * DAY).toISOString().slice(0, 10), source: 'device' as const,
    followers: 1000 + j * 10 + d * 3, following: 200 + (d % 7), posts: 20 + Math.floor(d / 5), capturedAt: new Date(now - (89 - d) * DAY),
  })));
  await chunked(stats, (p) => db.insert(schema.socialAccountStats).values(p));
  counts.accountStats = stats.length;
  const accountsOf = (u: string) => accRows.filter((a) => a.userId === u);

  // ------------------------------------------------------------ media (ready, fake keys: nothing reads the file)
  const M = 50 * scale;
  const media = await db.insert(schema.mediaAssets).values(Array.from({ length: M }, (_, i) => {
    const pub = i % 2 === 0;
    return {
      ownerType: (pub ? 'public' : 'user') as 'public' | 'user', ownerId: pub ? null : userIds[i % U]!, name: `ld-${tag}-media-${i}`,
      fileName: `ld-${i}.jpg`, storage: 'local' as const, fileKey: `ld/${tag}/${i}.jpg`, thumbnailKey: null, fileType: 'image' as const,
      mimeType: 'image/jpeg', fileSize: 100_000 + i, width: 1080, height: 1080, checksum: randomBytes(32).toString('hex'),
      status: 'ready' as const, createdBy: adminId, createdAt: new Date(now - i * 600_000),
    };
  })).returning({ id: schema.mediaAssets.id, ownerType: schema.mediaAssets.ownerType });
  const publicMedia = media.filter((m) => m.ownerType === 'public').map((m) => m.id);
  counts.media = M;

  // ------------------------------------------------------------ contents with one medium and one target
  const C = 500 * scale;
  const STATUS = ['draft', 'ready', 'published', 'published', 'failed', 'archived'] as const;
  const contentRows = Array.from({ length: C }, (_, i) => {
    const status = pick(STATUS, i);
    const stage = status === 'draft' ? 'draft' : status === 'archived' ? 'archived' : 'ready';
    return {
      userId: userIds[i % U]!, title: `ld-${tag} content ${i}`, body: `Load test body ${i} `.repeat(8), lang: 'zh-CN',
      stage: stage as 'draft' | 'ready' | 'archived', status, createdBy: userIds[i % U]!, createdAt: new Date(now - i * 120_000),
    };
  });
  const contents: { id: string; userId: string }[] = [];
  await chunked(contentRows, async (p) => contents.push(...await db.insert(schema.contents).values(p).returning({ id: schema.contents.id, userId: schema.contents.userId })));
  await chunked(contents.map((c, i) => ({ contentId: c.id, assetId: pick(publicMedia, i), position: 0 })), (p) => db.insert(schema.contentMedia).values(p));
  const targetOf = contents.map((c, i) => pick(accountsOf(c.userId), i));
  await chunked(contents.map((c, i) => ({ contentId: c.id, accountId: targetOf[i]!.id, position: 0 })), (p) => db.insert(schema.contentTargets).values(p));
  counts.contents = C;

  // ------------------------------------------------------------ publish history (finished rows only: no unfinished-pair conflicts)
  const P = 1000 * scale;
  const PST = ['published', 'published', 'failed', 'cancelled'] as const;
  await chunked(Array.from({ length: P }, (_, i) => {
    const ci = i % C;
    const st = pick(PST, i);
    const at = new Date(now - (i % 60) * DAY + (i % 24) * 3600_000 - 30 * DAY);
    return {
      userId: contents[ci]!.userId, contentId: contents[ci]!.id, accountId: targetOf[ci]!.id, platform: 'instagram',
      caption: `caption ${i}`, mediaIds: [pick(publicMedia, ci)], scheduledAt: at, status: st, method: 'manual', attemptNo: 1, maxAttempts: 1,
      publishedAt: st === 'published' ? at : null, errorCode: st === 'failed' ? 'publish.device_offline' : null, lang: 'zh-CN',
      externalId: st === 'published' ? String(3_000_000_000 + i) : null, createdBy: contents[ci]!.userId, createdAt: at,
    };
  }), (p) => db.insert(schema.publishTasks).values(p));
  counts.publishTasks = P;

  // ------------------------------------------------------------ comments: 80 % top level, 20 % replies in their threads
  const CM = 2000 * scale;
  await chunked(Array.from({ length: CM }, (_, i) => {
    const acc = accRows[i % A]!;
    const child = Math.floor(i / A) % 5 === 4; // round 4 of every 5 replies to the same account's comment of round 3
    return {
      userId: acc.userId, accountId: acc.id, platform: 'instagram', source: 'manual' as const, externalId: `ld-${i}`,
      parentExternalId: child ? `ld-${i - A}` : null,
      externalPostId: `post-${i % 50}`, authorName: `fan${i % 300}`, authorHandle: `fan${i % 300}`, text: `comment ${i} on the load test`,
      status: pick(['new', 'read', 'new', 'replied'] as const, i), publishedAt: new Date(now - i * 60_000),
    };
  }), (p) => db.insert(schema.comments).values(p));
  counts.comments = CM;

  // ------------------------------------------------------------ tracked accounts + 30 snapshots + 5 posts each
  const T = 100 * scale;
  const tracked: { id: string }[] = [];
  await chunked(Array.from({ length: T }, (_, i) => ({
    userId: userIds[i % U]!, platform: 'instagram', handle: `ld_${tag}_t${i}`, profileUrl: `https://www.instagram.com/ld_${tag}_t${i}/`,
    displayName: `Tracked ${i}`, tags: i % 3 ? ['load'] : [], favorite: i % 7 === 0, lastSource: 'device' as const, lastCheckedAt: new Date(now - i * 60_000),
    refreshIntervalHours: i % 2 ? 24 : null, nextRefreshAt: i % 2 ? new Date(now + 30 * DAY) : null,
  })), async (p) => tracked.push(...await db.insert(schema.trackedAccounts).values(p).returning({ id: schema.trackedAccounts.id })));
  await chunked(tracked.flatMap((t, i) => Array.from({ length: 30 }, (_, d) => ({
    trackedAccountId: t.id, capturedAt: new Date(now - (29 - d) * DAY), source: 'device' as const,
    followers: 10_000 + i * 100 + d * 17, following: 300, posts: 100 + d,
  }))), (p) => db.insert(schema.trackedAccountSnapshots).values(p));
  await chunked(tracked.flatMap((t, i) => Array.from({ length: 5 }, (_, k) => ({
    trackedAccountId: t.id, externalId: `${i}-${k}`, source: 'device' as const, url: `https://www.instagram.com/p/ld${i}x${k}/`,
    title: `tracked post ${k}`, publishedAt: new Date(now - k * DAY), likes: 100 * k, comments: k,
  }))), (p) => db.insert(schema.trackedPosts).values(p));
  counts.tracked = T;
  counts.trackedSnapshots = T * 30;

  // ------------------------------------------------------------ finished tasks with 3 log lines each
  const TK = 2000 * scale;
  const TYPES = ['install-apk', 'tracked-refresh', 'publish', 'media-process', 'account-device-check'] as const;
  const taskIds: string[] = [];
  await chunked(Array.from({ length: TK }, (_, i) => {
    const dev = i % 3 === 0 ? devices[i % D]! : null;
    const at = new Date(now - i * 300_000);
    return {
      type: pick(TYPES, i), instanceId: dev?.id ?? null, instanceName: `ld-${tag} task ${i}`, status: pick(['success', 'success', 'failed', 'cancelled'] as const, i),
      attempts: 1, maxAttempts: 1, createdBy: i % 4 === 0 ? adminId : userIds[i % U]!, createdAt: at, startedAt: at, finishedAt: new Date(at.getTime() + 5000),
      errorCode: i % 4 === 2 ? 'task.timeout' : null,
    };
  }), async (p) => taskIds.push(...(await db.insert(schema.tasks).values(p).returning({ id: schema.tasks.id })).map((r) => r.id)));
  await chunked(taskIds.flatMap((id) => ['created', 'running', 'finished'].map((m) => ({ taskId: id, level: 'info' as const, message: m }))), (p) => db.insert(schema.taskLogs).values(p));
  counts.tasks = TK;

  // ------------------------------------------------------------ notifications (users + admin)
  const N = 2000 * scale;
  const who = [adminId, ...userIds];
  await chunked(Array.from({ length: N }, (_, i) => ({
    userId: pick(who, i), kind: pick(['device.down', 'publish.failed', 'account.problem'] as const, i), severity: 'warning' as const,
    params: { name: `ld-${tag}` }, refType: 'instance', refId: devices[i % D]!.id, readAt: i % 3 ? new Date(now) : null, createdAt: new Date(now - i * 90_000),
  })), (p) => db.insert(schema.notifications).values(p as never));
  counts.notifications = N;

  return { devices, accounts: accRows, publicMedia, counts };
}

/** Removes everything seeded or created by a run with this tag (users cascade their own rows). */
export async function cleanupLoad(tag: string, userIds: string[], adminId: string): Promise<void> {
  const devs = await db.select({ id: schema.instances.id }).from(schema.instances).where(like(schema.instances.name, `ld-${tag}-%`));
  const devIds = devs.map((d) => d.id);
  // admin notifications / alert states caused by the run (publish.failed on the users' rounds, device alerts)
  const pubIds = userIds.length ? (await db.select({ id: schema.publishTasks.id }).from(schema.publishTasks).where(inArray(schema.publishTasks.userId, userIds))).map((r) => r.id) : [];
  const refs = [...devIds, ...pubIds];
  for (let i = 0; i < refs.length; i += 1000) {
    const part = refs.slice(i, i + 1000);
    await db.delete(schema.notifications).where(sql`${schema.notifications.userId} = ${adminId} and ${inArray(schema.notifications.refId, part)}`);
  }
  await db.delete(schema.tasks).where(or(like(schema.tasks.instanceName, `ld-${tag}%`), userIds.length ? inArray(schema.tasks.createdBy, userIds) : undefined, devIds.length ? inArray(schema.tasks.instanceId, devIds) : undefined));
  if (userIds.length) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await db.delete(schema.mediaAssets).where(like(schema.mediaAssets.fileKey, `ld/${tag}/%`));
  if (devIds.length) await db.delete(schema.instances).where(inArray(schema.instances.id, devIds));
}
