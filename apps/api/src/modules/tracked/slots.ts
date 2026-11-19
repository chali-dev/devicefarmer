import { createHash } from 'node:crypto';

/** 定时采集 slot maths (pure; shared by the scheduler, the routes and the data migration). */
export const HOUR_MS = 3600_000;
/** Default 定时采集 interval of new Instagram tracked accounts (read on its 采集手机). */
export const IG_DEFAULT_INTERVAL_HOURS = 24;

/** Stable 0–59 minute offset per account (spreads the runs over the hour). */
export const offsetMinutes = (id: string) => createHash('sha256').update(id).digest().readUInt16BE(0) % 60;

/** First slot after enabling: within the next hour, at the account's minute offset. */
export function firstSlot(id: string, now = new Date()): Date {
  const hourStart = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  let t = hourStart + offsetMinutes(id) * 60_000;
  if (t <= now.getTime()) t += HOUR_MS;
  return new Date(t);
}
