/**
 * List prices for the models Ateam's sessions run on, USD per million
 * tokens, so a transcript's `usage` blocks can be turned into what they
 * actually bill. Cache writes are 1.25× input and cache reads 0.1× input on
 * every model except Claude Fable 5.1 / Mythos 5.1, whose cache reads are
 * a flat $0.25/MTok. Source: Anthropic first-party API rates (2026-06).
 *
 * A model we do not know (a codex/gpt thread, a renamed snapshot, the
 * `<synthetic>` placeholder claude writes for local messages) prices at
 * zero and is reported as unpriced tokens rather than guessed.
 */

export interface ModelPrice {
  /** USD per 1M uncached input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cache-creation (write) tokens */
  cacheWrite: number;
  /** USD per 1M cache-read tokens */
  cacheRead: number;
}

interface PriceRule {
  /** matched as a substring of the model id, most specific first */
  match: string;
  input: number;
  output: number;
  /** override for the flat cache-read rate (Fable 5.1) */
  cacheRead?: number;
}

const RULES: readonly PriceRule[] = [
  { match: 'fable-5-1', input: 10, output: 50, cacheRead: 0.25 },
  { match: 'mythos-5-1', input: 10, output: 50, cacheRead: 0.25 },
  { match: 'fable-5', input: 10, output: 50 },
  { match: 'mythos-5', input: 10, output: 50 },
  { match: 'opus-5', input: 5, output: 25 },
  { match: 'opus-4-8', input: 5, output: 25 },
  { match: 'opus-4-7', input: 5, output: 25 },
  { match: 'opus-4-6', input: 5, output: 25 },
  { match: 'opus-4-5', input: 5, output: 25 },
  { match: 'opus-4', input: 15, output: 75 },
  { match: 'sonnet-5', input: 2, output: 10 },
  { match: 'sonnet-4', input: 3, output: 15 },
  { match: 'sonnet-3', input: 3, output: 15 },
  { match: 'haiku-4-5', input: 1, output: 5 },
  { match: 'haiku-3-5', input: 0.8, output: 4 },
  { match: 'haiku-3', input: 0.25, output: 1.25 },
];

/** The price sheet for a model id, or undefined when it is not a model we
 *  can price. */
export function modelPrice(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const id = model.toLowerCase();
  for (const r of RULES) {
    if (!id.includes(r.match)) continue;
    return {
      input: r.input,
      output: r.output,
      cacheWrite: r.input * 1.25,
      cacheRead: r.cacheRead ?? r.input * 0.1,
    };
  }
  return undefined;
}

export interface TokenBuckets {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** USD for one usage block on `model`; 0 when the model is unpriced. */
export function usageCostUsd(model: string | undefined, u: TokenBuckets): number {
  const p = modelPrice(model);
  if (!p) return 0;
  return (
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheCreationTokens * p.cacheWrite +
      u.cacheReadTokens * p.cacheRead) /
    1_000_000
  );
}
