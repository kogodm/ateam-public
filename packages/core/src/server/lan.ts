import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import type { LanServerHandle, Port } from '@ateam/transport';
import { startLanServer } from '@ateam/transport';
import { loadConfig, saveConfig, verifyLanPassword } from '../config';
import { type Recovery, findHolder, killHolder, nextRecovery } from './port-recovery';
import { verifyTunnelToken } from './tunnel-auth';

export interface LanStatus {
  running: boolean;
  enabled: boolean;
  passwordSet: boolean;
  port: number;
  /** http://<lan-ip>:<port> for every non-internal IPv4 interface */
  urls: string[];
  error?: string;
}

/** Where the built desktop UI lives, mirroring promptsDir()'s candidates:
 *  bundled sidecar (dist/ui, shipped by bundle-native.mjs) or the repo's
 *  vite output when running core from source. */
function uiDir(): string | undefined {
  const here = typeof __dirname !== 'undefined' ? __dirname : dirname(process.argv[1] ?? '.');
  const candidates = [
    join(here, 'ui'), // bundled sidecar (dist/ui)
    join(here, '..', '..', 'desktop', 'ui', 'dist'), // tsx dev: argv[1]=apps/sidecar/src
    join(here, '..', '..', '..', '..', 'apps', 'desktop', 'ui', 'dist'), // core/src/server → repo
  ];
  return candidates.find((c) => existsSync(join(c, 'index.html')));
}

function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) urls.push(`http://${info.address}:${port}`);
    }
  }
  return urls;
}

/** Owns the LAN server's lifecycle: reconciles the running state against
 *  config.lan on boot and after every config.set. Password verification
 *  re-reads config each attempt, so a password change applies live. */
export class LanController {
  private handle?: LanServerHandle;
  private lastError = '';
  private applying = Promise.resolve();

  constructor(
    private readonly onConnection: (port: Port) => void,
    /** the LAN port moved — whoever tunnels into it must re-dial */
    private readonly onPortChanged?: (port: number) => void,
  ) {}

  /** Serialized reconcile — config.set can fire while a start is in flight. */
  apply(): Promise<void> {
    this.applying = this.applying.then(() => this.reconcile());
    return this.applying;
  }

  private async reconcile(): Promise<void> {
    const lan = loadConfig().lan;
    const wantRunning = lan.enabled && !!lan.passwordHash;
    if (this.handle && (!wantRunning || this.handle.port !== lan.port)) {
      await this.handle.close().catch(() => {});
      this.handle = undefined;
    }
    if (!wantRunning || this.handle) return;
    await this.listen(lan.port);
  }

  private serve(port: number): Promise<LanServerHandle> {
    return startLanServer({
      port,
      uiDir: uiDir(),
      verifyPassword: (pw) => verifyLanPassword(loadConfig().lan, pw),
      verifyTunnelToken,
      onConnection: this.onConnection,
    });
  }

  /**
   * Take the port, working around whoever holds it (see port-recovery).
   * A single lost race used to be permanent: one EADDRINUSE and the pane read
   * "Not running" until somebody noticed, with remote access dead the whole
   * time — and the commonest cause is our own predecessor still letting go
   * one second after a restart.
   */
  private async listen(want: number): Promise<void> {
    const startedAt = Date.now();
    const killed: number[] = [];
    for (let attempt = 0; ; attempt++) {
      try {
        this.handle = await this.serve(want);
        this.lastError = '';
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes('EADDRINUSE')) {
          this.lastError = msg; // a different failure — nothing here would help
          return;
        }
        const step: Recovery = nextRecovery({
          attempt,
          elapsedMs: Date.now() - startedAt,
          holder: findHolder(want),
          killed,
        });
        if (step.step === 'kill') {
          killHolder(step.pid);
          killed.push(step.pid);
          continue;
        }
        if (step.step === 'retry') {
          await new Promise((r) => setTimeout(r, step.delayMs));
          continue;
        }
        await this.moveOff(want);
        return;
      }
    }
  }

  /** Out of time on the configured port: take a free one and keep the service
   *  up. Persisted, so the next launch does not fight for the old port again
   *  and the relay (which dials the port from config) follows. */
  private async moveOff(want: number): Promise<void> {
    try {
      this.handle = await this.serve(0); // 0 = let the OS pick a free one
      const cur = loadConfig();
      saveConfig({ ...cur, lan: { ...cur.lan, port: this.handle.port } });
      this.lastError = `port ${want} was still taken after 30s — moved to ${this.handle.port}`;
      this.onPortChanged?.(this.handle.port);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  status(): LanStatus {
    const lan = loadConfig().lan;
    return {
      running: !!this.handle,
      enabled: lan.enabled,
      passwordSet: !!lan.passwordHash,
      port: this.handle?.port ?? lan.port,
      urls: this.handle ? lanUrls(this.handle.port) : [],
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async shutdown(): Promise<void> {
    await this.handle?.close().catch(() => {});
    this.handle = undefined;
  }
}
