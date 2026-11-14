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
