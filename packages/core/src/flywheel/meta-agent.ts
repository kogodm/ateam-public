import { EventEmitter } from 'node:events';
import type { ProjectTree, SessionNode } from '@ateam/contract';
import { listHumans } from '../humans';
import type { Flywheel } from './flywheel';
import { type MetaState, loadMetaState, saveMetaState } from './meta-state';

/** Minimal view of the session manager (so MetaAgent is unit-testable). */
export interface SessionSource {
  list(): ProjectTree[];
  get(sessionId: string): SessionNode | undefined;
  on(event: 'status', cb: (e: { sessionId: string; state: string }) => void): unknown;
}

const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * ⑤ The legacy AssetStore flywheel loop. The actually-live self-evolution
 * path today is knowledge-consolidation-at-handoff (see human-meta.ts):
 * the handoff session itself writes skills/knowledge/experiences straight
 * into `~/.ateam/users/local/agents/<humanId>/meta/`, no LLM re-analysis,
 * no drops inbox (that in-session "claude drops a JSON file, sidecar
 * ingests it next spawn" design was built once but its recall-path wiring
 * was later removed in favor of meta.md — see git history on `../drops.ts`
 * if reviving it). Only meta.md is injected at spawn; AssetStore is not.
 *
 * This class is what's left of the OLDER AssetStore-backed pipeline, kept
 * alive only for:
 *  - ② distill ≥3 same-domain experiences of a human into a Skill (LLM
 *    call, but rare — only when a domain crosses the threshold)
 *  - ④ daily confidence decay (pure local)
 * Emits `skill` / `progress`; the server rebroadcasts as evolution.*.
 * OFF by default (`ATEAM_AUTOEVOLVE=1` to enable the timer — see
 * rpc-server.ts). AssetStore's only remaining *input* is the `flywheel.reflect`
 * RPC (no UI trigger anymore since the ✨ Reflect button was removed) — so
 * with the timer off and no manual reflect call, this store simply stops
 * growing. That's fine: it doesn't feed recall or the Growth panel (which
 * now browses meta.md's files directly) — it's effectively a frozen legacy
 * store until/unless something is built to consume or migrate it.
 */
export class MetaAgent extends EventEmitter {
  private state: MetaState = loadMetaState();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly sessions: SessionSource,
    private readonly flywheel: Flywheel,
    private readonly opts: { tickMs?: number } = {},
  ) {
    super();
  }

  start(): void {
    this.timer = setInterval(() => void this.runNow(), this.opts.tickMs ?? 120_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async distillSweep(): Promise<number> {
    let made = 0;
    for (const h of listHumans()) {
      const byDomain = new Map<string, number>();
      for (const e of this.flywheel.listExperiences(h.id)) {
        byDomain.set(e.domain, (byDomain.get(e.domain) ?? 0) + 1);
      }
      for (const [domain, count] of byDomain) {
        if (count < 3) continue;
        const key = `${h.id}|${domain}`;
        if (count <= (this.state.distilled[key] ?? 0)) continue;
        this.emit('progress', { phase: 'distill', detail: `${h.name}:${domain}` });
        const used = await this.flywheel.distillDomain(h.id, domain);
        if (used) {
          this.state.distilled[key] = count;
          saveMetaState(this.state);
          made++;
          this.emit('skill', { agentKey: h.id, source: 'distilled', count: 1 });
        }
      }
    }
    return made;
  }

  private decayIfDue(): void {
    const now = Date.now();
    const last = this.state.lastDecayAt ? Date.parse(this.state.lastDecayAt) : 0;
    if (now - last < DECAY_INTERVAL_MS) return;
    this.emit('progress', { phase: 'decay', detail: '' });
    this.flywheel.decayAll();
    this.state.lastDecayAt = new Date().toISOString();
    saveMetaState(this.state);
  }

  /** One full maintenance pass (also the manual `meta.runNow`). Reflection
   *  is no longer performed here — sessions record their own learnings via
   *  the drops inbox. The contract result shape keeps `reflected` for
   *  back-compat (always 0). */
  async runNow(): Promise<{ reflected: number; distilled: number }> {
    if (this.running) return { reflected: 0, distilled: 0 };
    this.running = true;
    try {
      const distilled = await this.distillSweep();
      this.decayIfDue();
      if (distilled) {
        this.emit('progress', { phase: 'done', detail: `+${distilled} skill` });
      }
      return { reflected: 0, distilled };
    } finally {
      this.running = false;
    }
  }

  /** Same sweep as runNow but scoped to ONE human — backs the Human edit
   *  page's ✨ Reorganize button. Returns per-domain distilled counts so the
   *  UI can show "+2 skill in deploy, +1 in tdd". */
  async runForHuman(
    humanId: string,
  ): Promise<{ distilled: number; byDomain: Record<string, number> }> {
    if (this.running) return { distilled: 0, byDomain: {} };
    this.running = true;
    try {
      const h = listHumans().find((x) => x.id === humanId);
      if (!h) return { distilled: 0, byDomain: {} };
      const byDomain: Record<string, number> = {};
      let total = 0;
      const counts = new Map<string, number>();
      for (const e of this.flywheel.listExperiences(h.id)) {
        counts.set(e.domain, (counts.get(e.domain) ?? 0) + 1);
      }
      for (const [domain, count] of counts) {
        if (count < 3) continue;
        const key = `${h.id}|${domain}`;
        if (count <= (this.state.distilled[key] ?? 0)) continue;
        this.emit('progress', { phase: 'distill', detail: `${h.name}:${domain}` });
        const used = await this.flywheel.distillDomain(h.id, domain);
        if (used) {
          this.state.distilled[key] = count;
          saveMetaState(this.state);
          byDomain[domain] = (byDomain[domain] ?? 0) + 1;
          total++;
          this.emit('skill', { agentKey: h.id, source: 'distilled', count: 1 });
        }
      }
      // decay is global+cheap; running it inside the per-human action is
      // honest "reorganize" semantics for the user — and the user-visible
      // counter is still the per-human one (`total`).
      this.decayIfDue();
      return { distilled: total, byDomain };
    } finally {
      this.running = false;
    }
  }
}
