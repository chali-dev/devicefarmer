/**
 * Asset library (素材库) + storage settings, through the public HTTP API against real storage. No mocks.
 * Requires: API running. The S3 part needs a real S3-compatible endpoint (e.g. SeaweedFS) given by env:
 *   S3_TEST_ENDPOINT, S3_TEST_REGION (default us-east-1), S3_TEST_BUCKET, S3_TEST_ACCESS_KEY, S3_TEST_SECRET_KEY
 * The bucket is created if missing. Objects are verified independently with the AWS SDK.
 * Leaves storage set to local and deletes everything it created.
 * Usage: npx tsx --env-file=../../.env scripts/assets-check.ts
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { CreateBucketCommand, DeleteObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';

const API = process.env.E2E_API ?? 'http://127.0.0.1:3000';
const ASSET_DIR = path.resolve(process.env.ASSET_DIR ?? 'var/assets');
const S3 = process.env.S3_TEST_ENDPOINT ? {
  endpoint: process.env.S3_TEST_ENDPOINT, region: process.env.S3_TEST_REGION ?? 'us-east-1', bucket: process.env.S3_TEST_BUCKET!,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY!, secretAccessKey: process.env.S3_TEST_SECRET_KEY!, forcePathStyle: true, prefix: 'cp-test/',
} : null;

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function http<T = any>(method: string, p: string, token?: string, body?: unknown) {
  const res = await fetch(API + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json as T, text };
}

async function download(id: string, token: string, query = '') {
  const res = await fetch(`${API}/api/assets/${id}/content${query}`, { headers: { authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf, sha: createHash('sha256').update(buf).digest('hex') };
}

async function upload(token: string, name: string, data: Buffer, mime: string) {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(data)], { type: mime }), name);
  return http<{ asset: any }>('POST', '/api/assets', token, fd);
}

/** A real 32x32 RGB PNG (so Android's media scanner can decode it). */
function png(seed: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const w = 32, h = 32;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (x * 8 + seed) & 255; raw[o + 1] = (y * 8) & 255; raw[o + 2] = seed & 255; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const login = async (username: string, password: string) => (await http<{ token: string }>('POST', '/api/auth/login', undefined, { username, password })).body.token;

const created: string[] = [];
const admin = await login(process.env.ADMIN_USERNAME ?? 'admin', process.env.ADMIN_PASSWORD!);
check('admin login', Boolean(admin));
const tag = randomBytes(3).toString('hex');

try {
  // ---------- (b) local backend ----------
  const toLocal = await http('PUT', '/api/settings/storage', admin, { type: 'local' });
  check('PUT storage local', toLocal.status === 200, `${toLocal.status}`);
  const localTest = await http('POST', '/api/settings/storage/test', admin);
  check('test stored (local) storage', localTest.status === 200 && localTest.body.ok === true, JSON.stringify(localTest.body));

  const img = png(1);
  const bin = randomBytes(5000);
  const upImg = await upload(admin, `测试图片-${tag}.png`, img, 'image/png');
  check('upload image (local)', upImg.status === 201 && upImg.body.asset.storage === 'local' && upImg.body.asset.sha256 === sha(img) && upImg.body.asset.size === img.length, `${upImg.status} ${upImg.body?.asset?.storage}`);
  const upBin = await upload(admin, `data-${tag}.bin`, bin, 'application/octet-stream');
  check('upload non-image (local)', upBin.status === 201 && upBin.body.asset.mime === 'application/octet-stream', `${upBin.status}`);
  const a1 = upImg.body.asset, a2 = upBin.body.asset;
  created.push(a1.id, a2.id);
  const onDisk = path.join(ASSET_DIR, a1.key);
  check('image object on local disk', fs.existsSync(onDisk) && fs.statSync(onDisk).size === img.length, onDisk);

  const all = await http<{ assets: any[] }>('GET', '/api/assets', admin);
  check('list contains both', all.status === 200 && [a1.id, a2.id].every((id) => all.body.assets.some((a) => a.id === id)));
  const imgs = await http<{ assets: any[] }>('GET', '/api/assets?type=image', admin);
  check('filter type=image', imgs.body.assets.some((a) => a.id === a1.id) && !imgs.body.assets.some((a) => a.id === a2.id) && imgs.body.assets.every((a) => a.mime.startsWith('image/')));
  const others = await http<{ assets: any[] }>('GET', '/api/assets?type=other', admin);
  check('filter type=other', others.body.assets.some((a) => a.id === a2.id) && !others.body.assets.some((a) => a.id === a1.id));
  const vids = await http<{ assets: any[] }>('GET', '/api/assets?type=video', admin);
  check('filter type=video excludes both', !vids.body.assets.some((a) => a.id === a1.id || a.id === a2.id));
  const q = await http<{ assets: any[] }>('GET', `/api/assets?q=${encodeURIComponent(`图片-${tag}`)}`, admin);
  check('search by name', q.body.assets.length === 1 && q.body.assets[0].id === a1.id, `${q.body.assets.length} hit(s)`);

  const dl = await download(a1.id, admin);
  check('download image sha256 matches', dl.status === 200 && dl.sha === sha(img) && dl.headers.get('content-type') === 'image/png', `${dl.status} ${dl.headers.get('content-type')}`);
  const dl2 = await download(a2.id, admin, '?download=1');
  check('download=1 sets attachment + sha matches', dl2.status === 200 && dl2.sha === sha(bin) && (dl2.headers.get('content-disposition') ?? '').startsWith('attachment;'), dl2.headers.get('content-disposition') ?? '');

  const patched = await http<{ asset: any }>('PATCH', `/api/assets/${a1.id}`, admin, { name: `改名-${tag}.png`, tags: [`tag-${tag}`, '活动', `tag-${tag}`] });
  check('PATCH name + tags (deduped)', patched.status === 200 && patched.body.asset.name === `改名-${tag}.png` && patched.body.asset.tags.length === 2, JSON.stringify(patched.body.asset?.tags));
  const byTag = await http<{ assets: any[] }>('GET', `/api/assets?q=tag-${tag}`, admin);
  check('search by tag', byTag.body.assets.length === 1 && byTag.body.assets[0].id === a1.id);

  const delBin = await http('DELETE', `/api/assets/${a2.id}`, admin);
  const binPath = path.join(ASSET_DIR, a2.key);
  check('DELETE removes row and file', delBin.status === 204 && !fs.existsSync(binPath) && (await download(a2.id, admin)).status === 404, `${delBin.status}`);
  created.splice(created.indexOf(a2.id), 1);

  // ---------- (f) RBAC ----------
  const vname = `viewer_${tag}`;
  const vpass = randomBytes(12).toString('base64url');
  const vu = await http<{ user: { id: string } }>('POST', '/api/users', admin, { username: vname, password: vpass, role: 'viewer' });
  check('create throwaway viewer', vu.status === 201, `${vu.status}`);
  try {
    const viewer = await login(vname, vpass);
    check('viewer can list assets', (await http('GET', '/api/assets', viewer)).status === 200);
    check('viewer can read content', (await download(a1.id, viewer)).status === 200);
    const vUp = await upload(viewer, 'x.png', img, 'image/png');
    check('viewer upload → 403', vUp.status === 403, `${vUp.status}`);
    const vDel = await http('DELETE', `/api/assets/${a1.id}`, viewer);
    check('viewer delete → 403', vDel.status === 403, `${vDel.status}`);
    const vPatch = await http('PATCH', `/api/assets/${a1.id}`, viewer, { tags: ['x'] });
    check('viewer patch → 403', vPatch.status === 403, `${vPatch.status}`);
    const vPush = await http('POST', '/api/assets/push', viewer, { assetIds: [a1.id], instanceIds: ['00000000-0000-4000-8000-000000000000'] });
    check('viewer push → 403', vPush.status === 403, `${vPush.status}`);
    check('viewer GET storage settings → 403', (await http('GET', '/api/settings/storage', viewer)).status === 403);
    const vPut = await http('PUT', '/api/settings/storage', viewer, { type: 'local' });
    check('viewer PUT storage settings → 403', vPut.status === 403, `${vPut.status}`);
    check('viewer POST storage test → 403', (await http('POST', '/api/settings/storage/test', viewer)).status === 403);
    check('asset untouched after viewer attempts', (await download(a1.id, admin)).sha === sha(img));
  } finally {
    const d = await http('DELETE', `/api/users/${vu.body.user.id}`, admin);
    check('delete throwaway viewer', d.status === 204 || d.status === 200, `${d.status}`);
  }

  // ---------- (c) + (d) S3 ----------
  if (!S3) {
    console.log('S3_TEST_* not set: skipping S3 checks');
  } else {
    const sdk = new S3Client({ endpoint: S3.endpoint, region: S3.region, forcePathStyle: true, credentials: { accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey } });
    await sdk.send(new CreateBucketCommand({ Bucket: S3.bucket })).catch((e: any) => { if (!/BucketAlready/.test(e.name)) throw e; });
    const head = (key: string) => sdk.send(new HeadObjectCommand({ Bucket: S3.bucket, Key: S3.prefix + key }))
      .then((r) => ({ status: 200, size: r.ContentLength }), (e: any) => ({ status: e.$metadata?.httpStatusCode ?? 0, size: undefined }));

    const good = { type: 's3', s3: S3 };
    const bad = { type: 's3', s3: { ...S3, secretAccessKey: S3.secretAccessKey.slice(0, -4) + 'XXXX' } };
    const t1 = await http('POST', '/api/settings/storage/test', admin, good);
    check('test correct s3 config → ok', t1.status === 200 && t1.body.ok === true, `latency ${t1.body.latencyMs} ms`);
    const t2 = await http('POST', '/api/settings/storage/test', admin, bad);
    check('test wrong secret → not ok', t2.status === 200 && t2.body.ok === false, t2.body.error);
    const p2 = await http('PUT', '/api/settings/storage', admin, bad);
    check('PUT with wrong secret refused', p2.status === 400, `${p2.status} ${p2.body?.error}`);
    const g2 = await http('GET', '/api/settings/storage', admin);
    check('settings unchanged after refused PUT', g2.body.storage.type === 'local');

    const p3 = await http('PUT', '/api/settings/storage', admin, good);
    check('PUT correct s3 config saved', p3.status === 200 && p3.body.storage.type === 's3', `${p3.status}`);
    const g3 = await http('GET', '/api/settings/storage', admin);
    check('GET shows hasSecret, no secret in response', g3.body.storage.s3.hasSecret === true && !g3.text.includes(S3.secretAccessKey) && !('secretAccessKey' in g3.body.storage.s3) && !('secretEnc' in g3.body.storage.s3), JSON.stringify(Object.keys(g3.body.storage.s3)));
    check('PUT response has no secret', !p3.text.includes(S3.secretAccessKey));
    const { secretAccessKey: _omit, ...noSecret } = S3;
    const p4 = await http('PUT', '/api/settings/storage', admin, { type: 's3', s3: noSecret });
    check('PUT without secret (same endpoint/bucket/key) keeps stored secret', p4.status === 200 && p4.body.storage.s3.hasSecret, `${p4.status}`);
    const p5 = await http('PUT', '/api/settings/storage', admin, { type: 's3', s3: { ...noSecret, bucket: `${S3.bucket}-other` } });
    check('PUT without secret but changed bucket → 400', p5.status === 400, p5.body?.error);
    const t3 = await http('POST', '/api/settings/storage/test', admin);
    check('test stored (s3) config with body omitted → ok', t3.body.ok === true, JSON.stringify(t3.body));

    const img2 = png(2);
    const up3 = await upload(admin, `s3图片-${tag}.png`, img2, 'image/png');
    const a3 = up3.body.asset;
    created.push(a3.id);
    check('upload image goes to s3', up3.status === 201 && a3.storage === 's3', `${up3.status} ${a3?.storage}`);
    const h3 = await head(a3.key);
    check('object exists in bucket (SDK HeadObject)', h3.status === 200 && h3.size === img2.length, `HeadObject ${h3.status}, ${h3.size} bytes, key ${S3.prefix}${a3.key}`);
    check('object not written to local disk', !fs.existsSync(path.join(ASSET_DIR, a3.key)));
    const dl3 = await download(a3.id, admin);
    check('s3 download sha256 matches', dl3.status === 200 && dl3.sha === sha(img2));

    // (d) the local asset uploaded before switching is still readable
    const dl1 = await download(a1.id, admin);
    check('old local asset still downloads after switching to s3', dl1.status === 200 && dl1.sha === sha(img));

    const del3 = await http('DELETE', `/api/assets/${a3.id}`, admin);
    const h3b = await head(a3.key);
    check('DELETE s3 asset removes object', del3.status === 204 && h3b.status === 404, `DELETE ${del3.status}, HeadObject ${h3b.status}`);
    created.splice(created.indexOf(a3.id), 1);

    // Unreadable object → clear 502
    const up4 = await upload(admin, `orphan-${tag}.bin`, randomBytes(100), 'application/octet-stream');
    created.push(up4.body.asset.id);
    await sdk.send(new DeleteObjectCommand({ Bucket: S3.bucket, Key: S3.prefix + up4.body.asset.key }));
    const r502 = await fetch(`${API}/api/assets/${up4.body.asset.id}/content`, { headers: { authorization: `Bearer ${admin}` } });
    const b502 = await r502.json().catch(() => ({}));
    check('missing s3 object → 502 with reason', r502.status === 502 && /s3/.test(b502.error ?? ''), `${r502.status} ${b502.error}`);
    sdk.destroy();
  }
} finally {
  // Cleanup: back to local, delete created assets
  const back = await http('PUT', '/api/settings/storage', admin, { type: 'local' });
  check('cleanup: storage back to local', back.status === 200 && back.body.storage.type === 'local');
  for (const id of created) {
    const d = await http('DELETE', `/api/assets/${id}`, admin);
    check(`cleanup: delete asset ${id}`, d.status === 204, `${d.status}`);
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
