import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertKey, probeStorage, type ObjectStorage, type StorageTestResult } from './types.js';

/** Files under a directory on the API host. */
export class LocalStorage implements ObjectStorage {
  readonly kind = 'local' as const;
  private readonly root: string;
  constructor(dir: string) { this.root = path.resolve(dir); }

  private pathFor(key: string): string {
    assertKey(key);
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error(`invalid storage key: ${key}`);
    return p;
  }

  async put(key: string, source: string | Readable, size: number, _contentType: string): Promise<void> {
    const dest = this.pathFor(key);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    try {
      if (typeof source === 'string') await fs.promises.copyFile(source, tmp);
      else await pipeline(source, fs.createWriteStream(tmp));
      const st = await fs.promises.stat(tmp);
      if (st.size !== size) throw new Error(`size mismatch: wrote ${st.size}, expected ${size}`);
      await fs.promises.rename(tmp, dest);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true });
      throw err;
    }
  }

  async getStream(key: string): Promise<Readable> {
    const p = this.pathFor(key);
    const fh = await fs.promises.open(p, 'r'); // fails fast (ENOENT) before any byte is sent
    return fh.createReadStream();
  }

  async delete(key: string): Promise<void> {
    await fs.promises.rm(this.pathFor(key), { force: true });
  }

  test(): Promise<StorageTestResult> { return probeStorage(this); }
}
