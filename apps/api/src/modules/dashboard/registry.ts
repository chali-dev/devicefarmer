import type { AuthUser } from '../auth/rbac.js';

/**
 * Dashboard (概览) widget registry. Each module registers one provider that returns its widget data
 * for a request context, already filtered by RBAC, or null when the widget does not apply (e.g. an
 * admin-only widget for a user). Providers must use aggregate SQL (no per-row queries).
 *
 * Extension point: a new module (e.g. comments & engagement) calls
 *   registerDashboardWidget('comments', async (ctx) => ({ ... }), { order: 65 })
 * at import time; GET /api/dashboard then returns it under `widgets.comments`, and the web
 * dashboard renders it once a card for that key is added (DashboardView.vue).
 */
export interface DashboardCtx {
  /** Who asked. */
  viewer: AuthUser;
  /**
   * Whose visibility applies: the viewer, or (admin "per user" view) the picked user treated as a
   * `user`, so the numbers are exactly what that user sees.
   */
  scope: AuthUser;
  /** isAdmin(scope): everything is visible. */
  admin: boolean;
  now: Date;
  /** IANA time zone for day buckets (validated). */
  tz: string;
}

export type DashboardProvider = (ctx: DashboardCtx) => Promise<unknown>;

const providers = new Map<string, { fn: DashboardProvider; order: number }>();

export function registerDashboardWidget(key: string, fn: DashboardProvider, opts: { order?: number } = {}): void {
  if (providers.has(key)) throw new Error(`dashboard widget already registered: ${key}`);
  providers.set(key, { fn, order: opts.order ?? 100 });
}

/** Runs every provider in parallel. One failing widget does not fail the dashboard. */
export async function collectDashboard(ctx: DashboardCtx): Promise<{ order: string[]; widgets: Record<string, unknown>; errors: Record<string, string> }> {
  const list = [...providers.entries()].sort((a, b) => a[1].order - b[1].order);
  const settled = await Promise.allSettled(list.map(([, p]) => p.fn(ctx)));
  const widgets: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const order: string[] = [];
  settled.forEach((r, i) => {
    const key = list[i]![0];
    if (r.status === 'rejected') { errors[key] = (r.reason as Error)?.message ?? String(r.reason); return; }
    if (r.value === null || r.value === undefined) return;
    widgets[key] = r.value;
    order.push(key);
  });
  return { order, widgets, errors };
}
