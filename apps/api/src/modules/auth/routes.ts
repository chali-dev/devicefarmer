import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db, schema } from '../../db/index.js';
import { badRequest, unauthorized } from '../../lib/errors.js';
import { auditRequest } from '../audit/audit.js';
import { captchaEnabled, checkCaptcha, createChallenge, isCaptchaError } from './captcha.js';

/** Public profile of a user (never includes passwordHash). */
const profileColumns = {
  id: schema.users.id,
  username: schema.users.username,
  role: schema.users.role,
  displayName: schema.users.displayName,
  email: schema.users.email,
  builtin: schema.users.builtin,
};

async function loadProfile(id: string) {
  const [u] = await db.select(profileColumns).from(schema.users).where(eq(schema.users.id, id));
  if (!u) throw unauthorized('account disabled or removed', 'auth.account_disabled');
  return u;
}

// '' (after trimming) clears the field.
const emptyToNull = (v: string) => (v === '' ? null : v);

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  // Slider puzzle captcha (captcha.ts). Unauthenticated; `{ enabled: false }` when LOGIN_CAPTCHA=off.
  app.get('/api/auth/captcha', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!captchaEnabled()) return { enabled: false };
    return { enabled: true, ...(await createChallenge(req)) };
  });

  // Checked on release by the web; a correct answer stays usable once for the login (audit-excluded).
  app.post('/api/auth/captcha/verify', async (req) => {
    if (!captchaEnabled()) return { ok: true };
    await checkCaptcha(req.body, { keepIfRight: true });
    return { ok: true };
  });

  app.post('/api/auth/login', {
    // `captcha` is validated by checkCaptcha so that a missing/malformed one gets its own code.
    schema: { body: z.object({ username: z.string().min(1), password: z.string().min(1), captcha: z.unknown().optional() }) },
  }, async (req) => {
    // Before the password and the user lookup: guards brute force and reveals nothing about the username.
    if (captchaEnabled()) {
      try {
        await checkCaptcha(req.body.captcha);
      } catch (e) {
        if (isCaptchaError(e)) {
          auditRequest(req, {
            action: 'auth.login_failed', userId: null, username: req.body.username.slice(0, 64), target: req.body.username.slice(0, 64), status: 400,
            detail: { reason: e.reason },
          });
        }
        throw e;
      }
    }
    const [u] = await db.select().from(schema.users).where(eq(schema.users.username, req.body.username));
    // Compare even when the user is missing to keep timing similar.
    const ok = await bcrypt.compare(req.body.password, u?.passwordHash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!u || !ok || u.disabled) {
      // Excluded from the generic hook; only the attempted username is kept, never the password.
      auditRequest(req, {
        action: 'auth.login_failed', userId: u?.id ?? null, username: req.body.username.slice(0, 64), target: req.body.username.slice(0, 64), status: 401,
        detail: { reason: !u ? 'unknown_user' : u.disabled && ok ? 'disabled' : 'bad_password' },
      });
      throw unauthorized('invalid username or password', 'auth.invalid_credentials');
    }
    const token = app.jwt.sign({ sub: u.id });
    auditRequest(req, { action: 'auth.login', userId: u.id, username: u.username, target: u.username, targetId: u.id, status: 200 });
    return { token, user: { id: u.id, username: u.username, role: u.role, displayName: u.displayName, email: u.email, builtin: u.builtin } };
  });

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (req) => ({ user: await loadProfile(req.user.id) }));

  app.patch('/api/auth/me', {
    preHandler: app.authenticate,
    schema: {
      body: z.object({
        displayName: z.string().trim().max(40).transform(emptyToNull).optional(),
        email: z.union([z.literal(''), z.string().trim().max(254).pipe(z.email())]).transform(emptyToNull).optional(),
      }),
    },
  }, async (req) => {
    const set: { displayName?: string | null; email?: string | null } = {};
    if (req.body.displayName !== undefined) set.displayName = req.body.displayName;
    if (req.body.email !== undefined) set.email = req.body.email;
    if (Object.keys(set).length) await db.update(schema.users).set(set).where(eq(schema.users.id, req.user.id));
    return { user: await loadProfile(req.user.id) };
  });

  app.post('/api/auth/password', {
    preHandler: app.authenticate,
    schema: {
      body: z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(8).max(128),
      }),
    },
  }, async (req, reply) => {
    const [u] = await db.select({ passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, req.user.id));
    if (!u) throw unauthorized('account disabled or removed', 'auth.account_disabled');
    if (!(await bcrypt.compare(req.body.currentPassword, u.passwordHash))) throw badRequest('当前密码不正确', 'auth.wrong_password');
    if (req.body.newPassword === req.body.currentPassword) throw badRequest('新密码不能与当前密码相同', 'auth.same_password');
    const passwordHash = await bcrypt.hash(req.body.newPassword, 10);
    await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, req.user.id));
    return reply.code(204).send();
  });
};
