import type { ProxyConfig } from '../../db/schema.js';

/**
 * Per-instance network policy, verified on redroid (see docs/05-proxy-design.md):
 * - Android's netd flushes `ip rule`s, so tun/auto_route cannot capture app traffic.
 *   Instead nftables (left alone by netd) redirects TCP + DNS to sing-box.
 * - sing-box's own sockets carry SINGBOX_MARK and are bound to eth0 so netd's
 *   `oif eth0` rules route them.
 * - Kill switch: filter policy drop. Only loopback (redirected), sing-box's marked
 *   traffic and the Docker bridge (adb/platform) may leave. No direct fallback, no IPv6,
 *   non-DNS UDP (QUIC etc.) is dropped so apps fall back to TCP.
 */
export const SINGBOX_MARK = 0x2023;
const REDIRECT_PORT = 7892;
const DNS_PORT = 5353;

export function buildRules(proxy: ProxyConfig | null, bridgeSubnet: string): string {
  const header = 'table inet cloudphone\ndelete table inet cloudphone\n';
  if (!proxy) return `${header}table inet cloudphone {}\n`; // direct mode: no policy
  const mark = `0x${SINGBOX_MARK.toString(16)}`;
  return `${header}table inet cloudphone {
  chain nat_out {
    type nat hook output priority -100; policy accept;
    meta mark ${mark} return
    oif "lo" return
    ip daddr { 127.0.0.0/8, ${bridgeSubnet} } return
    meta l4proto tcp redirect to :${REDIRECT_PORT}
    udp dport 53 redirect to :${DNS_PORT}
  }
  chain filter_out {
    type filter hook output priority 0; policy drop;
    oif "lo" accept
    ip daddr 127.0.0.0/8 accept
    meta mark ${mark} accept
    ip daddr ${bridgeSubnet} accept
  }
}
`;
}

export function buildConfig(proxy: ProxyConfig | null): object {
  if (!proxy) {
    // Direct mode keeps the sidecar running (it owns the netns) without touching traffic.
    return { log: { level: 'warn' }, outbounds: [{ type: 'direct', tag: 'direct' }] };
  }
  const auth = proxy.username ? { username: proxy.username, password: proxy.password ?? '' } : {};
  const outbound = proxy.type === 'socks5'
    ? { type: 'socks', tag: 'proxy', server: proxy.host, server_port: proxy.port, version: '5', ...auth }
    : { type: 'http', tag: 'proxy', server: proxy.host, server_port: proxy.port, ...auth };
  return {
    log: { level: 'warn' },
    dns: {
      servers: [{ type: 'tcp', tag: 'remote', server: '8.8.8.8', detour: 'proxy' }],
      final: 'remote',
      strategy: 'ipv4_only',
    },
    inbounds: [
      { type: 'redirect', tag: 'redir-in', listen: '127.0.0.1', listen_port: REDIRECT_PORT },
      { type: 'direct', tag: 'dns-in', listen: '127.0.0.1', listen_port: DNS_PORT, network: 'udp' },
    ],
    outbounds: [outbound],
    route: {
      rules: [
        { inbound: 'dns-in', action: 'hijack-dns' },
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
      ],
      final: 'proxy',
      default_mark: SINGBOX_MARK,
      default_interface: 'eth0',
      default_domain_resolver: 'remote',
    },
  };
}

/** Applies rules then runs sing-box; on SIGHUP sing-box reloads config.json (proxy change without restart). */
export const START_SCRIPT = `#!/bin/sh
set -e
nft -f /etc/cloudphone/rules.nft
exec sing-box run -c /etc/cloudphone/config.json
`;

/** Identity of a proxy endpoint, for the "no accidental sharing" check. */
export function proxyKey(p: ProxyConfig): string {
  return `${p.type}://${p.username ?? ''}@${p.host.toLowerCase()}:${p.port}`;
}
