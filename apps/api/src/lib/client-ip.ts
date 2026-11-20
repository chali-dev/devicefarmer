import type { FastifyRequest } from 'fastify';

/**
 * Client address for the login captcha rate limit and the audit log. Behind the reverse proxy (Caddy on the
 * same host, deploy/) every request comes from loopback, so the last X-Forwarded-For entry is used then: the
 * peer Caddy saw, or, when that peer is a proxy on the same host (e.g. 1Panel's OpenResty in front, itself
 * behind a CDN), the X-Real-IP it passed on (deploy/deploy.sh `write_upstream`). A direct connection from
 * elsewhere can't forge it.
 */
export function clientIp(req: FastifyRequest): string {
  const peer = req.socket.remoteAddress ?? req.ip;
  const loopback = peer === '::1' || peer.startsWith('127.') || peer.startsWith('::ffff:127.');
  const xff = req.headers['x-forwarded-for'];
  if (loopback && xff) {
    const last = (Array.isArray(xff) ? xff.join(',') : xff).split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last.slice(0, 64);
  }
  return peer;
}
