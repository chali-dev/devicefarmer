import { config } from '../../config.js';
import { S3Storage } from '../../adapters/storage/index.js';
import type { MediaAsset } from '../../db/schema.js';
import { storageFor } from '../settings/storage.js';
import { platformError } from './http.js';

/**
 * Public, time-limited media URLs for platforms that fetch media by URL (Instagram Graph API).
 * Only S3-compatible storage can provide them (SigV4 presigned GET, PLATFORM_MEDIA_URL_TTL_SEC).
 * Local storage, or an S3 endpoint that is plain http or obviously not reachable from the internet
 * (localhost, private ranges, *.local), cannot: the caller gets platform.media_url_unavailable.
 */
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)|\.local$|\.internal$|\.lan$/i;

function unavailable(reason: string) {
  return { code: 'platform.media_url_unavailable', message: `无法为平台生成公开的素材地址：${reason}`, params: { reason } };
}

/** Why `asset` cannot get a public URL (or null). Checks the storage backend the asset lives on. */
export async function mediaUrlProblem(asset: MediaAsset): Promise<{ code: string; message: string; params: { reason: string } } | null> {
  if (asset.storage !== 's3') return unavailable('local storage');
  let storage;
  try { storage = await storageFor('s3'); } catch { return unavailable('S3 not configured'); }
  if (!(storage instanceof S3Storage)) return unavailable('S3 not configured');
  if (storage.endpoint) {
    let u: URL;
    try { u = new URL(storage.endpoint); } catch { return unavailable('invalid S3 endpoint'); }
    if (u.protocol !== 'https:') return unavailable('S3 endpoint is not https');
    if (PRIVATE_HOST.test(u.hostname)) return unavailable('S3 endpoint is not public');
  }
  return null;
}

export async function publicMediaUrl(asset: MediaAsset): Promise<string> {
  const problem = await mediaUrlProblem(asset);
  if (problem) throw platformError(400, 'media_url_unavailable', problem.message, problem.params);
  const storage = (await storageFor('s3')) as S3Storage;
  return storage.presignGet(asset.fileKey, config.PLATFORM_MEDIA_URL_TTL_SEC);
}
