import { config } from '../../config.js';

/**
 * Media formats the library accepts. A file is accepted only when its extension, the declared
 * MIME type and its magic bytes all agree on one of these formats (MEDIA_ALLOWED_TYPES subset).
 */
export type MediaKind = 'image' | 'video';
export interface MediaFormat {
  id: string;
  kind: MediaKind;
  /** Canonical MIME type (stored and served). */
  mime: string;
  /** Other MIME types browsers/clients send for it. */
  mimeAliases: string[];
  /** Accepted extensions (lower case, no dot); the first is used for storage keys. */
  exts: string[];
  magic: (head: Buffer) => boolean;
}

const ascii = (b: Buffer, start: number, end: number) => b.subarray(start, end).toString('latin1');
/** ISO-BMFF (`....ftyp<brand>`): major brand at 8..12, compatible brands after it. */
function ftypBrands(b: Buffer): string[] | null {
  if (b.length < 12 || ascii(b, 4, 8) !== 'ftyp') return null;
  const size = Math.min(b.readUInt32BE(0), b.length);
  const brands = [ascii(b, 8, 12)];
  for (let o = 16; o + 4 <= size; o += 4) brands.push(ascii(b, o, o + 4));
  return brands;
}
const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'];
const QT_ATOMS = ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot'];

export const FORMATS: MediaFormat[] = [
  { id: 'jpeg', kind: 'image', mime: 'image/jpeg', mimeAliases: ['image/jpg', 'image/pjpeg'], exts: ['jpg', 'jpeg'], magic: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { id: 'png', kind: 'image', mime: 'image/png', mimeAliases: [], exts: ['png'], magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { id: 'webp', kind: 'image', mime: 'image/webp', mimeAliases: [], exts: ['webp'], magic: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  { id: 'gif', kind: 'image', mime: 'image/gif', mimeAliases: [], exts: ['gif'], magic: (b) => ['GIF87a', 'GIF89a'].includes(ascii(b, 0, 6)) },
  {
    id: 'heic', kind: 'image', mime: 'image/heic', mimeAliases: ['image/heif', 'image/heic-sequence', 'image/heif-sequence'], exts: ['heic', 'heif'],
    magic: (b) => Boolean(ftypBrands(b)?.some((x) => HEIF_BRANDS.includes(x))),
  },
  {
    id: 'mp4', kind: 'video', mime: 'video/mp4', mimeAliases: ['video/x-m4v'], exts: ['mp4', 'm4v'],
    magic: (b) => { const br = ftypBrands(b); return Boolean(br && !br.some((x) => HEIF_BRANDS.includes(x)) && br[0] !== 'qt  '); },
  },
  {
    id: 'mov', kind: 'video', mime: 'video/quicktime', mimeAliases: [], exts: ['mov'],
    magic: (b) => { const br = ftypBrands(b); return br ? br.includes('qt  ') : b.length >= 8 && QT_ATOMS.includes(ascii(b, 4, 8)); },
  },
  {
    id: 'webm', kind: 'video', mime: 'video/webm', mimeAliases: [], exts: ['webm'],
    magic: (b) => b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3 && ascii(b, 0, Math.min(b.length, 64)).includes('webm'),
  },
];

/** Bytes needed to decide magic numbers. */
export const MAGIC_BYTES = 64;

export function allowedFormats(): MediaFormat[] {
  const ids = new Set(config.MEDIA_ALLOWED_TYPES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return FORMATS.filter((f) => ids.has(f.id));
}

export function maxBytes(kind: MediaKind): number {
  return Math.floor((kind === 'image' ? config.MEDIA_IMAGE_MAX_MB : config.MEDIA_VIDEO_MAX_MB) * 1024 * 1024);
}
export function maxMb(kind: MediaKind): number {
  return kind === 'image' ? config.MEDIA_IMAGE_MAX_MB : config.MEDIA_VIDEO_MAX_MB;
}

export function extOf(filename: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(filename.trim());
  return m ? m[1]!.toLowerCase() : '';
}

/** Format by extension among the allowed ones (step 1, before any byte is read). */
export function formatByExt(filename: string): MediaFormat | undefined {
  const ext = extOf(filename);
  return ext ? allowedFormats().find((f) => f.exts.includes(ext)) : undefined;
}

/** Declared MIME must match the format; a generic/missing type is tolerated (magic bytes decide). */
export function mimeMatches(format: MediaFormat, declared: string): boolean {
  const m = declared.toLowerCase().split(';')[0]!.trim();
  return !m || m === 'application/octet-stream' || m === format.mime || format.mimeAliases.includes(m);
}

/** Limits as reported to the UI (GET /api/media/limits). */
export function mediaLimits() {
  const fmts = allowedFormats();
  const of = (kind: MediaKind) => ({
    maxMb: maxMb(kind),
    formats: fmts.filter((f) => f.kind === kind).map((f) => ({ id: f.id, mime: f.mime, mimes: [f.mime, ...f.mimeAliases], exts: f.exts })),
  });
  return { image: of('image'), video: of('video') };
}
