import { unzipSync } from 'fflate';
import fs from 'node:fs';

/** What the library needs from an APK's AndroidManifest.xml (the <manifest> element's attributes). */
export interface ApkManifest {
  package: string;
  /** Long version code as decimal text (versionCodeMajor << 32 | versionCode), like the device reports it. */
  versionCode: string;
  versionName: string | null;
  /** Set on config/feature split APKs; null for the base APK. */
  split: string | null;
}

// Binary XML (AXML) chunk types, ResourceTypes.h
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const UTF8_FLAG = 1 << 8;
// Typed value data types
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
// android: attribute resource ids (names may be stripped by obfuscators; ids are not)
const ATTR_VERSION_CODE = 0x0101021b;
const ATTR_VERSION_NAME = 0x0101021c;
const ATTR_VERSION_CODE_MAJOR = 0x01010576;

/** Reads the manifest of an APK file. Throws on anything that isn't a readable APK. */
export async function readApkManifest(apkPath: string): Promise<ApkManifest> {
  let entry: Uint8Array | undefined;
  try {
    entry = unzipSync(await fs.promises.readFile(apkPath), { filter: (f) => f.name === 'AndroidManifest.xml' })['AndroidManifest.xml'];
  } catch (err) {
    throw new Error(`not a zip/APK (${(err as Error).message})`);
  }
  if (!entry) throw new Error('no AndroidManifest.xml');
  return parseManifest(Buffer.from(entry.buffer, entry.byteOffset, entry.byteLength));
}

/** Attributes of the first element (<manifest>) of a binary AndroidManifest.xml. */
export function parseManifest(b: Buffer): ApkManifest {
  if (b.length < 8 || b.readUInt16LE(0) !== 0x0003) throw new Error('manifest is not binary XML');
  let strings: string[] = [];
  let resIds: number[] = [];
  for (let off = b.readUInt16LE(2); off + 8 <= b.length;) {
    const type = b.readUInt16LE(off);
    const headerSize = b.readUInt16LE(off + 2);
    const size = b.readUInt32LE(off + 4);
    if (size < 8 || off + size > b.length) throw new Error('corrupt manifest chunk');
    if (type === RES_STRING_POOL_TYPE) strings = readStringPool(b, off);
    else if (type === RES_XML_RESOURCE_MAP_TYPE) {
      resIds = [];
      for (let p = off + headerSize; p + 4 <= off + size; p += 4) resIds.push(b.readUInt32LE(p));
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      const ext = off + headerSize; // ns, name, attributeStart, attributeSize, attributeCount, …
      if (strings[b.readUInt32LE(ext + 4)] !== 'manifest') throw new Error('first element is not <manifest>');
      const attrStart = b.readUInt16LE(ext + 8);
      const attrSize = b.readUInt16LE(ext + 10);
      const attrCount = b.readUInt16LE(ext + 12);
      const attrs = new Map<string | number, { raw: string | null; type: number; data: number }>();
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        const nameIdx = b.readUInt32LE(a + 4);
        const rawIdx = b.readInt32LE(a + 8);
        const value = { raw: rawIdx >= 0 ? strings[rawIdx] ?? null : null, type: b.readUInt8(a + 15), data: b.readUInt32LE(a + 16) };
        attrs.set(resIds[nameIdx] ?? strings[nameIdx] ?? nameIdx, value);
        if (strings[nameIdx]) attrs.set(strings[nameIdx]!, value);
      }
      const str = (k: string | number) => {
        const v = attrs.get(k);
        return v ? (v.type === TYPE_STRING ? strings[v.data] ?? null : v.raw) : null;
      };
      const int = (k: number, name: string) => {
        const v = attrs.get(k) ?? attrs.get(name);
        return v && (v.type === TYPE_INT_DEC || v.type === TYPE_INT_HEX) ? v.data : v?.raw && /^\d+$/.test(v.raw) ? Number(v.raw) : null;
      };
      const pkg = str('package');
      const code = int(ATTR_VERSION_CODE, 'versionCode');
      if (!pkg || !/^[a-zA-Z0-9_.]{3,150}$/.test(pkg)) throw new Error('manifest has no valid package name');
      if (code === null) throw new Error('manifest has no versionCode');
      const major = int(ATTR_VERSION_CODE_MAJOR, 'versionCodeMajor') ?? 0;
      return {
        package: pkg,
        versionCode: ((BigInt(major) << 32n) | BigInt(code)).toString(),
        versionName: str(ATTR_VERSION_NAME) ?? str('versionName'),
        split: str('split'),
      };
    }
    off += size;
  }
  throw new Error('manifest has no <manifest> element');
}

function readStringPool(b: Buffer, off: number): string[] {
  const headerSize = b.readUInt16LE(off + 2);
  const count = b.readUInt32LE(off + 8);
  const utf8 = (b.readUInt32LE(off + 16) & UTF8_FLAG) !== 0;
  const start = off + b.readUInt32LE(off + 20);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = start + b.readUInt32LE(off + headerSize + i * 4);
    if (utf8) {
      p += b[p]! & 0x80 ? 2 : 1; // UTF-16 length, unused
      let len = b[p]!;
      if (len & 0x80) { len = ((len & 0x7f) << 8) | b[p + 1]!; p += 2; } else p += 1;
      out.push(b.toString('utf8', p, p + len));
    } else {
      let len = b.readUInt16LE(p);
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | b.readUInt16LE(p + 2); p += 4; } else p += 2;
      out.push(b.toString('utf16le', p, p + len * 2));
    }
  }
  return out;
}
