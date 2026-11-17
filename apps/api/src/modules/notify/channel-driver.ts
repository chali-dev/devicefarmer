import { UnrecoverableError } from 'bullmq';
import type { z } from 'zod';
import type { AlertKind } from './rules.js';

/**
 * Contract of an alert channel type (告警通道类型). One driver per type, registered in channels.ts; a new
 * type (webhook, email…) is one driver file plus one registry entry, no schema change.
 */
export interface AlertMessage { kind: AlertKind; recovered: boolean; params: Record<string, string | number>; refType: string | null; refId: string | null }

export interface ChannelDriver<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Full config with secret fields in plain text (as entered); validated on create and edit. */
  config: z.ZodType<C>;
  /** Secret config fields: stored sealed as `<field>Enc`, returned only as `<field>Set`. */
  secrets: readonly string[];
  /** Delivers an alert (or the test message). Throws ChannelFinalError (never retried) or anything else (retried). */
  send(cfg: C, msg: AlertMessage | { test: true }, signal?: AbortSignal): Promise<void>;
}

/** The channel refused the request for good (bad token, chat not found, bot blocked…): never retried. */
export class ChannelFinalError extends UnrecoverableError {
  constructor(readonly code: string, message: string, readonly params: Record<string, string | number> = {}) { super(message); }
}
