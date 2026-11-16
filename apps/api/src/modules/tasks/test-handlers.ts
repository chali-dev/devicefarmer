import { platformError } from '../platforms/http.js';
import { registerPublishMethod } from '../publish/methods.js';
import { registerTaskHandler, TaskError } from './core.js';

/**
 * Test-only task type for scripts/tasks-check.ts. Imported only when TASKS_TEST_HANDLERS=1
 * (main.ts, and the test script itself to create tasks); never registered in normal runs.
 *
 * payload: { sleepMs?: number, failTimes?: number (fail the first n attempts), failCode?: string,
 *            ignoreSignal?: boolean, result?: unknown }
 */
export interface TestPayload { sleepMs?: number; failTimes?: number; failCode?: string; ignoreSignal?: boolean; result?: unknown }

registerTaskHandler<TestPayload>('test.echo', {
  queue: 'task-ops',
  backoffMs: 1000,
  async run(ctx) {
    const p = ctx.payload;
    await ctx.log('info', 'test handler running', { attempt: ctx.attempt });
    if (p.sleepMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, p.sleepMs);
        if (!p.ignoreSignal) {
          ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(ctx.signal.reason as Error); }, { once: true });
        }
      });
    }
    if (p.failTimes && ctx.attempt <= p.failTimes) throw new TaskError(p.failCode ?? 'test.failure', `planned failure ${ctx.attempt}/${p.failTimes}`);
    return p.result ?? { ok: true, attempt: ctx.attempt };
  },
});

/**
 * Test-only 'api' publish method for Facebook (which has no real API adapter), for scripts/publish-check.ts.
 * Used only for captions starting with "[test:"; every other Facebook publish falls through to manual.
 *   [test:ok] → published   [test:permanent] → platform.media_rejected (400)   [test:transient] → platform.error (502)
 *   [test:after-send] → commit(), then platform.error (502)
 */
registerPublishMethod('facebook', {
  id: 'api',
  async unavailableReason(_account, input) {
    return input.caption.startsWith('[test:') ? null : { code: 'platform.unsupported', message: 'test method: caption is not a test caption' };
  },
  async publish(input, ctx) {
    const mode = /^\[test:([a-z-]+)\]/.exec(input.caption)?.[1];
    if (mode === 'permanent') throw platformError(400, 'media_rejected', 'test: media rejected', { platform: 'Facebook', error: 'test' });
    if (mode === 'transient') throw platformError(502, 'error', 'test: upstream 502', { platform: 'Facebook', status: 502, error: 'test' });
    await ctx.commit();
    if (mode === 'after-send') throw platformError(502, 'error', 'test: connection lost after sending', { platform: 'Facebook', status: 502, error: 'test' });
    return { state: 'published', externalId: `test-${input.publishTaskId}`, url: 'https://example.invalid/test' };
  },
});
