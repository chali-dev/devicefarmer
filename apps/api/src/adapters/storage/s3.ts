import fs from 'node:fs';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { assertKey, probeStorage, type ObjectStorage, type StorageTestResult } from './types.js';

export interface S3Options {
  /** Empty = AWS. Set for S3-compatible providers (Cloudflare R2, Aliyun OSS, SeaweedFS, ...). */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  /** Optional key prefix inside the bucket, e.g. "cloudphone/" */
  prefix?: string;
}

/** S3 or any S3-compatible object storage. */
export class S3Storage implements ObjectStorage {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly prefix: string;
  constructor(private readonly opts: S3Options) {
    this.client = new S3Client({
      endpoint: opts.endpoint || undefined,
      region: opts.region,
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      // Many S3-compatible providers reject the newer default CRC checksum headers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 2,
    });
    const p = (opts.prefix ?? '').replace(/^\/+/, '');
    this.prefix = p && !p.endsWith('/') ? `${p}/` : p;
  }

  private keyFor(key: string): string { assertKey(key); return this.prefix + key; }

  async put(key: string, source: string | Readable, size: number, contentType: string): Promise<void> {
    const body = typeof source === 'string' ? fs.createReadStream(source) : source;
    await this.client.send(new PutObjectCommand({
      Bucket: this.opts.bucket, Key: this.keyFor(key), Body: body, ContentLength: size, ContentType: contentType,
    }));
  }

  async getStream(key: string): Promise<Readable> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: this.keyFor(key) }));
    if (!r.Body) throw new Error('empty response body');
    return r.Body instanceof Readable ? r.Body : Readable.fromWeb(r.Body.transformToWebStream() as never);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: this.keyFor(key) }));
  }

  test(): Promise<StorageTestResult> { return probeStorage(this); }

  close(): void { this.client.destroy(); }
}
