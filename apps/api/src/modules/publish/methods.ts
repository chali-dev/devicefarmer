import { UnrecoverableError } from 'bullmq';
import type { MediaAsset, PostType, PublishTask, ReplyEvidence, SocialAccount } from '../../db/schema.js';
import type { TaskContext } from '../tasks/core.js';

/**
 * Publish methods (publish_tasks.method). Official-API publishing was removed on 2026-11-18; since the same day the
 * owner decided that a run is executed by the account's cloud phone in the Instagram app (method `device`,
 * modules/publish/device.ts) when it can, else it is handed to an operator (`manual`, always the fallback: the
 * operator publishes by hand via remote control and records the outcome).
 *
 * A method registers itself with `registerPublishMethod` (lower `priority` is tried first). `unavailable` says why
 * it can't take this run (a coded reason, logged; the next method is tried, finally `manual`).
 */

export interface PublishInput {
  publishTaskId: string;
  /** Scheduling round (bumped by reschedule / manual retry / deferral). */
  attemptNo: number;
  platform: string;
  account: SocialAccount;
  /** Platforms with titles (YouTube); undefined otherwise. */
  title?: string;
  caption: string;
  /** Without '#'. */
  hashtags: string[];
  /** Caption + hashtags, as it should appear on the platform. */
  text: string;
  /** e.g. { privacy: 'private' } */
  options: Record<string, unknown>;
  /** Ordered, all `ready`. */
  media: MediaAsset[];
  /** feed | reel | story (validated for the platform). */
  postType: PostType;
}

export type PublishLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The operator method (fallback of every run). */
export const MANUAL_METHOD = 'manual';
/** 云手机发帖: the account's cloud phone publishes in the app. */
export const DEVICE_METHOD = 'device';

/** Check failure that retrying won't fix: fails the run at once (no further attempts). */
export class PublishCheckError extends UnrecoverableError {
  constructor(readonly code: string, message: string, readonly params: Record<string, unknown> = {}) { super(message); }
}

/** What the run needs from the scheduler (no import of publish.ts from a method). */
export interface PublishRunContext {
  row: PublishTask;
  task: TaskContext<unknown>;
  log: (level: PublishLogLevel, message: string, data?: Record<string, unknown>) => Promise<void>;
}

export type PublishMethodResult =
  | { state: 'published'; externalId: string | null; url: string | null; publishedAt: Date | null; evidence?: ReplyEvidence | null; data?: Record<string, unknown> }
  /** The phone tried but an operator must finish / check it (e.g. publish.send_uncertain). */
  | { state: 'awaiting_operator'; code: string; message: string; evidence?: ReplyEvidence | null }
  /** Not now (pace, daily cap, busy phone): a new round at `at`. */
  | { state: 'deferred'; at: Date; code: string; message: string; data?: Record<string, unknown> }
  /** The phone is halted (风控): waits without a task until an admin resumes the device. */
  | { state: 'parked'; code: string; device: string }
  /** Found out while running that it can't take this run (e.g. adb doesn't see the phone): the next method takes it. */
  | { state: 'unavailable'; reason: string };

export interface PublishMethod {
  id: string;
  priority: number;
  unavailable(input: PublishInput, row: PublishTask): Promise<string | null>;
  run(input: PublishInput, ctx: PublishRunContext): Promise<PublishMethodResult>;
}

const methods: PublishMethod[] = [];
export function registerPublishMethod(m: PublishMethod): void {
  if (methods.some((x) => x.id === m.id)) throw new Error(`publish method ${m.id} registered twice`);
  methods.push(m);
  methods.sort((a, b) => a.priority - b.priority);
}
export const publishMethods = (): readonly PublishMethod[] => methods;
