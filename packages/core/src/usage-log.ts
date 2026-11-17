import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ateamHome } from './paths';

/** Append-only token-usage ledger for every LLM call the flywheel makes
 *  (reflection / distillation / repo learning) and every chat-side reply
 *  in chat mode. One JSON object per line at
 *  `~/.ateam/token-usage.jsonl` so cost is auditable after the fact. */
export interface UsageEntry {
  op: 'reflect' | 'distill' | 'learn' | 'chat';
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  /** e.g. agentKey/domain or session for context */
  detail?: string;
  /** chat mode: the chat this call spoke in (op 'chat') — summed per chat */
  chatId?: string;
}

export function usageLogPath(): string {
  return join(ateamHome(), 'token-usage.jsonl');
}

export function logUsage(e: UsageEntry): void {
  try {
    mkdirSync(ateamHome(), { recursive: true });
    appendFileSync(usageLogPath(), `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`);
  } catch {
    /* the ledger is best-effort — never break a flywheel call over logging */
  }
}

export interface UsageRecord extends UsageEntry {
  at: string;
}
export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** Read the ledger: totals span the WHOLE file; `entries` is the newest
 *  `limit` records, newest-first (for the GUI token view). */
export function readUsage(limit = 200): { entries: UsageRecord[]; totals: UsageTotals } {
  const totals: UsageTotals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
  let all: UsageRecord[] = [];
  try {
    for (const ln of readFileSync(usageLogPath(), 'utf8').split('\n')) {
      if (!ln.trim()) continue;
      try {
        const o = JSON.parse(ln) as UsageRecord;
        if (!o || !o.op) continue;
        all.push(o);
        totals.calls++;
        totals.inputTokens += o.inputTokens ?? 0;
        totals.outputTokens += o.outputTokens ?? 0;
        totals.cacheReadTokens += o.cacheReadTokens ?? 0;
        totals.cacheCreationTokens += o.cacheCreationTokens ?? 0;
        totals.costUsd += o.costUsd ?? 0;
      } catch {
        /* skip a malformed line */
      }
    }
  } catch {
    /* no ledger yet */
  }
  all = all.slice(-limit).reverse();
  return { entries: all, totals };
}

/** Tokens the chat-side replies of one chat have used so far (all four
 *  billed buckets summed). Reads the ledger; it is small. */
export function chatUsageTotals(chatId: string): {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
} {
  const t = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
  let raw: string;
  try {
    raw = readFileSync(usageLogPath(), 'utf8');
  } catch {
    return t;
  }
  for (const ln of raw.split('\n')) {
    if (!ln.includes(chatId)) continue;
    try {
      const e = JSON.parse(ln) as UsageEntry;
      if (e.chatId !== chatId) continue;
      t.calls++;
      t.inputTokens += e.inputTokens ?? 0;
      t.outputTokens += e.outputTokens ?? 0;
      t.cacheReadTokens += e.cacheReadTokens ?? 0;
      t.cacheCreationTokens += e.cacheCreationTokens ?? 0;
      t.costUsd += e.costUsd ?? 0;
    } catch {
      /* torn line */
    }
  }
  return t;
}
