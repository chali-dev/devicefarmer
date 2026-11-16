import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { bitbrowserError, type BitAdbInfo, type BitBrowserClient } from './bitbrowser.js';

/**
 * SSH tunnels to BitBrowser cloud phones' adbd: one `ssh -N -L bind:<localPort>:<target>` child per
 * device. The gateway password comes fresh from the BitBrowser client for every tunnel and is only
 * handed to ssh through an askpass helper reading it from the child's environment (never on the
 * command line, on disk, in the DB or in task payloads). Tunnels are renewed before the adb grant
 * expires; the monitor re-opens dropped ones.
 */
interface Tunnel { proc: ChildProcess; localPort: number; expiresAt: Date | null; openedAt: number }

const RENEW_BEFORE_MS = 30 * 60_000;
const READY_TIMEOUT_MS = 20_000;
const tunnels = new Map<string, Tunnel>();
const pending = new Map<string, Promise<void>>();

let askpass: string | null = null;
function askpassScript(): string {
  if (askpass && fs.existsSync(askpass)) return askpass;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-askpass-'));
  askpass = path.join(dir, 'askpass.sh');
  fs.writeFileSync(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$CP_SSH_PASS"\n', { mode: 0o700 });
  return askpass;
}

const forwardSpec = (localPort: number) => `${config.EXTERNAL_ADB_BIND}:${localPort}:`;

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: config.EXTERNAL_ADB_BIND, port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1500, () => done(false));
  });
}

/** Kills an ssh left over from an earlier API process that still holds this forward. */
function killStale(localPort: number): void {
  spawnSync('pkill', ['-f', `-L ${forwardSpec(localPort)}`], { stdio: 'ignore' });
}

function spawnTunnel(info: BitAdbInfo, localPort: number): ChildProcess {
  fs.mkdirSync(path.dirname(path.resolve(config.BITBROWSER_KNOWN_HOSTS)), { recursive: true });
  const args = [
    '-N', '-T',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${path.resolve(config.BITBROWSER_KNOWN_HOSTS)}`,
    '-o', 'PubkeyAuthentication=no',
    '-o', 'PreferredAuthentications=password,keyboard-interactive',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15',
    '-p', String(info.sshPort),
    '-L', `${forwardSpec(localPort)}${info.targetHost}:${info.targetPort}`,
    `${info.sshUser}@${info.sshHost}`,
  ];
  return spawn(config.SSH_PATH, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? os.homedir(), SSH_ASKPASS: askpassScript(), SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0', CP_SSH_PASS: info.password },
  });
}

async function open(instanceId: string, client: BitBrowserClient, phoneId: string, localPort: number): Promise<void> {
  close(instanceId);
  if (await portOpen(localPort)) killStale(localPort);
  const info = await client.adbInfo(phoneId);
  const proc = spawnTunnel(info, localPort);
  let stderr = '';
  proc.stderr?.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-500); });
  const t: Tunnel = { proc, localPort, expiresAt: info.expiresAt, openedAt: Date.now() };
  tunnels.set(instanceId, t);
  proc.once('exit', () => { if (tunnels.get(instanceId) === t) tunnels.delete(instanceId); });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      const why = stderr.replace(/\s+/g, ' ').trim() || `ssh exited (${proc.exitCode ?? proc.signalCode})`;
      throw bitbrowserError(`adb tunnel failed: ${why}`, 'tunnel_failed');
    }
    if (await portOpen(localPort)) return;
    if (Date.now() > deadline) { close(instanceId); throw bitbrowserError('adb tunnel did not come up in time', 'tunnel_failed'); }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export function tunnelUp(instanceId: string): boolean {
  const t = tunnels.get(instanceId);
  return Boolean(t && t.proc.exitCode === null && t.proc.signalCode === null);
}

/** Opens the tunnel if missing, dead or close to the adb grant's expiry. Concurrent callers share one attempt. */
export function ensureTunnel(instanceId: string, client: BitBrowserClient, phoneId: string, localPort: number): Promise<void> {
  const t = tunnels.get(instanceId);
  const fresh = t && tunnelUp(instanceId) && t.localPort === localPort && (!t.expiresAt || t.expiresAt.getTime() - Date.now() > RENEW_BEFORE_MS);
  if (fresh) return Promise.resolve();
  const inflight = pending.get(instanceId);
  if (inflight) return inflight;
  const p = open(instanceId, client, phoneId, localPort).finally(() => pending.delete(instanceId));
  pending.set(instanceId, p);
  return p;
}

export function close(instanceId: string): void {
  const t = tunnels.get(instanceId);
  if (!t) return;
  tunnels.delete(instanceId);
  t.proc.kill('SIGTERM');
}

export function closeAllTunnels(): void {
  for (const id of [...tunnels.keys()]) close(id);
}

// Tunnels are children of this process: don't leave them behind on exit.
process.once('exit', closeAllTunnels);
