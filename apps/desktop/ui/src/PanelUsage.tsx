import type { Result } from '@ateam/contract';
import { useEffect, useMemo, useState } from 'react';
import type { Rpc } from './rpc';

type Plan = Result<'usage.plan'>['plans'][number];
type ProviderId = Plan['providerId'];

const DAY = 24 * 3600 * 1000;
/** SVG ring geometry */
const R = 16;
const C = 2 * Math.PI * R;

function resetText(resetsAtSec: number, now: number): string {
  const at = new Date(resetsAtSec * 1000);
  const clock = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const days = (at.getTime() - now) / DAY;
  if (at.toDateString() === new Date(now).toDateString()) return `Resets at ${clock}`;
  if (days < 7) return `Resets ${at.toLocaleDateString('en-US', { weekday: 'long' })} ${clock}`;
  return `Resets ${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${clock}`;
}

const tone = (pct: number): string =>
  pct < 50 ? 'lo' : pct < 80 ? 'ok' : pct < 95 ? 'warn' : 'danger';

function focusProviderId(providerId: string | undefined): ProviderId | null {
  if (providerId === 'claude' || providerId === 'codex' || providerId === 'cursor')
    return providerId;
  return null;
}

function windowOf(plan: Plan | undefined, label: string): Plan['windows'][number] | undefined {
  return plan?.windows.find((w) => w.label === label);
}

/** ChatGPT gets one ring: prefer the week window, else session, else first. */
function chatGptWindow(plan: Plan | undefined): Plan['windows'][number] | undefined {
  if (!plan) return undefined;
  return windowOf(plan, 'This week') ?? windowOf(plan, 'Current session') ?? plan.windows[0];
}

export interface UsageRingSlot {
  key: string;
  providerId: ProviderId;
  /** short name under the ring */
  name: string;
  /** even shorter sub-label (5h / week / auto / API) */
  sub: string;
  usedPercent?: number;
  resetsAt?: number;
  plan?: string;
}

/** Fixed five slots so the Status strip stays one row. */
export function usageRingSlots(plans: Plan[]): UsageRingSlot[] {
  const by = new Map(plans.map((p) => [p.providerId, p]));
  const claude = by.get('claude');
  const codex = by.get('codex');
  const cursor = by.get('cursor');
  const cSession = windowOf(claude, 'Current session');
  const cWeek = windowOf(claude, 'This week');
  const gpt = chatGptWindow(codex);
  const curAuto = windowOf(cursor, 'Cursor Models');
  const curApi = windowOf(cursor, 'Other Models');
  return [
    {
      key: 'claude-5h',
      providerId: 'claude',
      name: 'Claude',
      sub: '5h',
      usedPercent: cSession?.usedPercent,
      resetsAt: cSession?.resetsAt,
      plan: claude?.plan,
    },
    {
      key: 'claude-week',
      providerId: 'claude',
      name: 'Claude',
      sub: 'week',
      usedPercent: cWeek?.usedPercent,
      resetsAt: cWeek?.resetsAt,
      plan: claude?.plan,
    },
    {
      key: 'gpt',
      providerId: 'codex',
      name: 'GPT',
      sub: gpt?.label === 'Current session' ? '5h' : 'week',
      usedPercent: gpt?.usedPercent,
      resetsAt: gpt?.resetsAt,
      plan: codex?.plan,
    },
    {
      key: 'cursor-auto',
      providerId: 'cursor',
      name: 'Cursor',
      sub: 'auto',
      usedPercent: curAuto?.usedPercent,
      resetsAt: curAuto?.resetsAt,
      plan: cursor?.plan,
    },
    {
      key: 'cursor-api',
      providerId: 'cursor',
      name: 'Cursor',
      sub: 'API',
      usedPercent: curApi?.usedPercent,
      resetsAt: curApi?.resetsAt,
      plan: cursor?.plan,
    },
  ];
}

function UsageRing({
  slot,
  on,
  now,
}: {
  slot: UsageRingSlot;
  on: boolean;
  now: number;
}): JSX.Element {
  const has = typeof slot.usedPercent === 'number';
  const pct = has ? Math.min(100, Math.max(0, slot.usedPercent as number)) : 0;
  const dash = (pct / 100) * C;
  const tip = has
    ? [
        `${slot.name} ${slot.sub}`,
        slot.plan ? `(${slot.plan})` : '',
        `${Math.round(pct)}% used`,
        slot.resetsAt ? resetText(slot.resetsAt, now) : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : `${slot.name} ${slot.sub} · no data yet`;
  return (
    <div className={`usage-ring ${on ? 'on' : 'off'}${has ? '' : ' empty'}`} title={tip}>
      <svg
        viewBox="0 0 40 40"
        className={`usage-ring-svg ${has ? tone(pct) : ''}`}
        role="img"
        aria-label={tip}
      >
        <circle className="usage-ring-track" cx="20" cy="20" r={R} />
        {has && (
          <circle
            className="usage-ring-fill"
            cx="20"
            cy="20"
            r={R}
            strokeDasharray={`${dash} ${C}`}
            transform="rotate(-90 20 20)"
          />
        )}
        <text
          className="usage-ring-pct"
          x="20"
          y="21"
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {has ? `${Math.round(pct)}` : '—'}
        </text>
      </svg>
      <div className="usage-ring-name">{slot.name}</div>
      <div className="usage-ring-sub">{slot.sub}</div>
    </div>
  );
}

/**
 * One compact row of five usage rings (Claude 5h / Claude week / GPT /
 * Cursor auto / Cursor API). Focused session's provider stays bright.
 */
export function PanelUsage({
  rpc,
  sessionId,
  providerId,
}: {
  rpc: Rpc;
  sessionId: string;
  providerId?: string;
}): JSX.Element | null {
  const [plans, setPlans] = useState<Plan[] | undefined>(undefined);
  useEffect(() => {
    let stop = false;
    setPlans(undefined);
    const pull = (): void => {
      rpc
        .request('usage.plan', { sessionId })
        .then((r) => {
          if (!stop) setPlans(r.plans);
        })
        .catch(() => undefined);
    };
    pull();
    const timer = setInterval(pull, 20000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [rpc, sessionId]);

  const slots = useMemo(() => (plans ? usageRingSlots(plans) : []), [plans]);
  const anyData = slots.some((s) => typeof s.usedPercent === 'number');

  if (plans === undefined) {
    return (
      <div className="status-section">
        <div className="status-section-title">Usage</div>
        <div className="muted small">Loading…</div>
      </div>
    );
  }
  if (!anyData) return null;

  const focus = focusProviderId(providerId);
  const now = Date.now();
  return (
    <div className="status-section status-usage-row">
      <div className="status-section-title">Usage</div>
      <div className="usage-rings">
        {slots.map((slot) => (
          <UsageRing key={slot.key} slot={slot} on={focus === slot.providerId} now={now} />
        ))}
      </div>
    </div>
  );
}
