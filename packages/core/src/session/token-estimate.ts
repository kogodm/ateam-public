import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import type { ProviderId } from '@ateam/contract';
import { storeTranscriptPath } from './provider-store';

/**
 * Per-session token count for the auto-handoff threshold + Status panel.
 *
 * PRIMARY signal: claude itself records exact per-turn `usage` records
 * in its on-disk transcript jsonl. The LATEST assistant turn's record
 * gives us the real token count claude saw on that round — matches what
 * `/context` reports inside the TUI. Fields we care about:
 *
 *   usage.input_tokens                — fresh uncached input this turn
 *   usage.cache_creation_input_tokens — new content being added to cache
 *   usage.cache_read_input_tokens     — existing cached context replayed
 *
 * Sum of those three = the total context size on that turn (matches the
 * effective in-context tokens claude is reasoning over).
 *
 * CODEX records the same idea in its own shape: `token_count` events whose
 * `last_token_usage.input_tokens` is the whole prompt for that turn (unlike
 * claude, codex's input_tokens ALREADY includes the cached part, so summing
 * the cache fields on top would double-count). Its `total_token_usage` is
 * cumulative over the session — NOT the context size — so it must not be used
 * here. Reading these through the provider-aware path is the fix for "codex
 * sessions always show 0": the old code looked for a claude transcript that a
 * codex session never writes, found nothing, and returned zero forever.
 *
 * FALLBACK: for very fresh sessions (no assistant turns yet) we use the
 * old bytes/30 heuristic — empirically transcripts pack ~30 bytes per
 * token because tool_result blobs (Bash output, file reads, base64) have
 * a lot of bytes that don't translate to tokens.
 */
export function estimateTokensFromTranscript(
  cwd: string,
  sessionStoreId: string,
  providerId: ProviderId = 'claude',
): { tokens: number; bytes: number; estimated?: true; contextWindow?: number } {
  const path = storeTranscriptPath(providerId, cwd, sessionStoreId);
  if (!path || !existsSync(path)) return { tokens: 0, bytes: 0 };
  let bytes = 0;
  try {
    bytes = statSync(path).size;
  } catch {
    return { tokens: 0, bytes: 0 };
  }

  if (providerId === 'codex') {
    const ctx = lastCodexContext(path);
    if (ctx.tokens > 0) return { ...ctx, bytes };
    return { ...ctx, tokens: Math.floor(bytes / 30), bytes, estimated: true };
  }

  // Try to read the LAST usage record. We tail the last 256KB of the
  // file (one assistant turn's record fits easily in that window even
  // with verbose tool_use blocks). Walk newline-delimited records from
  // the bottom up; the last turn that actually spent tokens is the answer.
  const latest = lastContextTokens(path);
  if (latest > 0) return { tokens: latest, bytes };

  // Fallback: no usage record yet (fresh session). Coarse byte-based
  // estimate so the Status bar isn't blank — refined to /30 to match
  // observed pack density. Once claude does its first response the
  // primary signal takes over. `estimated` tells callers that must act on
  // a real number (the experience checkpoint) not to.
  return { tokens: Math.floor(bytes / 30), bytes, estimated: true };
}

interface UsageBlock {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/** Read up to `bytes` from the tail of `path` and return complete lines
 *  (drops the partial leading line if not at file start). Same pattern
 *  used by the slug-listing and claude-summary code. */
function tailLines(path: string, bytes: number): string[] {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const len = Math.min(bytes, size);
    const pos = Math.max(0, size - len);
    const buf = Buffer.alloc(len);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, pos);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    // drop partial first line unless we started at byte 0
    if (pos > 0) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Context size of the last MAIN-conversation turn that actually spent
 * tokens, or 0 when the tail holds none.
 *
 * Two record kinds must be walked past, or the Status panel reads a number
 * that isn't this conversation's context:
 *
 *  - `<synthetic>` assistant records (interrupts, "No response requested",
 *    API-error messages) carry an all-zero usage block. Stopping on one
 *    returned 0, which sent the caller into the bytes/30 fallback — on a
 *    multi-MB transcript that reads ~3x the real context, so the panel
 *    flipped between the two values on every poll (724K red bar <-> 247K).
 *  - `isSidechain` records are a Task/subagent's own, much smaller context.
 */
/** How far back lastContextTokens looks, widening only when a narrower
 *  tail held no usage. 256KB is nearly always enough — an assistant record
 *  is a few KB. It is NOT when the newest records are pictures: two Reads
 *  of image sheets appended ~2.5MB of base64 with no assistant record after
 *  them, the tail found nothing, and the bytes/30 fallback called a 442K
 *  session 1,379,371 tokens — which fired an experience checkpoint (09-24). */
const USAGE_TAILS = [256 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];
const USAGE_KEY = Buffer.from('"usage"');
const BOUNDARY_KEY = Buffer.from('"compact_boundary"');
const NL = 0x0a;

/**
 * The context size claude recorded for its own compaction, when that
 * compaction is NEWER than the usage line starting at `after`.
 *
 * `system/compact_boundary` carries `compactMetadata.postTokens` — the size of
 * the context the next request starts from. Claude writes no usage record
 * between the boundary and its next reply, so without this the last usage is
 * the pre-compaction one: the panel kept showing ~225K for an 11K context, and
 * the auto-handoff prompt and the experience checkpoint read the same number.
 * 0 = no boundary after it (or none that says what the context became).
 */
function postCompactionTokens(buf: Buffer, after: number): number {
  let end = buf.length;
  while (end > after) {
    const hit = buf.lastIndexOf(BOUNDARY_KEY, end - 1);
    if (hit <= after) return 0;
    const start = buf.lastIndexOf(NL, hit) + 1;
    const nl = buf.indexOf(NL, hit);
    try {
      const obj = JSON.parse(buf.toString('utf8', start, nl < 0 ? buf.length : nl)) as {
        type?: string;
        subtype?: string;
        compactMetadata?: { postTokens?: unknown };
      };
      // the key also appears in text a tool printed — only the system record counts
      if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
        const post = Number(obj.compactMetadata?.postTokens);
        return Number.isFinite(post) && post > 0 ? post : 0;
      }
    } catch {
      /* a partial line, or not the record */
    }
    end = start - 1;
  }
  return 0;
}

function lastContextTokens(path: string): number {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    fd = openSync(path, 'r');
    for (const want of USAGE_TAILS) {
      const len = Math.min(want, size);
      // unsafe = not zero-filled: every byte is overwritten by the read
      const buf = Buffer.allocUnsafe(len);
      const got = readSync(fd, buf, 0, len, size - len);
      const found = usageInBuffer(buf.subarray(0, got), len < size);
      if (found > 0 || len >= size) return found;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The newest main-conversation usage in a tail of the transcript, found on
 * the raw bytes: jump from one `"usage"` to the previous with lastIndexOf and
 * decode only the line around each hit. A picture's base64 can never contain
 * a quote, so megabytes of it are passed over at memchr speed instead of
 * being decoded to a string and split into lines (16ms → 2.3ms on a
 * 41MB transcript ending in two picture records).
 */
function usageInBuffer(buf: Buffer, partialHead: boolean): number {
  let end = buf.length;
  while (end > 0) {
    const hit = buf.lastIndexOf(USAGE_KEY, end - 1);
    if (hit < 0) return 0;
    const start = buf.lastIndexOf(NL, hit) + 1;
    // the first line of a tail that began mid-file is cut off — unusable
    if (start === 0 && partialHead) return 0;
    const nl = buf.indexOf(NL, hit);
    const stop = nl < 0 ? buf.length : nl;
    try {
      const obj = JSON.parse(buf.toString('utf8', start, stop)) as {
        isSidechain?: boolean;
        message?: { usage?: UsageBlock };
        usage?: UsageBlock;
      };
      const u = obj.isSidechain ? undefined : (obj.message?.usage ?? obj.usage);
      const total = u
        ? (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0)
        : 0;
      if (total > 0) return postCompactionTokens(buf, start) || total;
    } catch {
      /* a partial last line (claude mid-write) or not JSON */
    }
    end = start - 1; // the line before this one
  }
  return 0;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function lastCodexContext(path: string): { tokens: number; contextWindow?: number } {
  let contextWindow: number | undefined;
  const result = (tokens: number) => ({
    tokens,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  });
  for (const tailBytes of USAGE_TAILS) {
    const lines = tailLines(path, tailBytes);
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (!line || !/"(?:token_count|compacted|context_compacted)"/.test(line)) continue;
      try {
        const record = JSON.parse(line) as {
          type?: string;
          payload?: {
            type?: string;
            info?: {
              model_context_window?: unknown;
              last_token_usage?: { input_tokens?: unknown; total_tokens?: unknown };
            };
          };
        };
        if (record.type === 'compacted') {
          return result(0);
        }
        if (record.type !== 'event_msg' || record.payload?.type !== 'token_count') continue;
        const info = record.payload.info;
        if (contextWindow === undefined && positiveFinite(info?.model_context_window)) {
          contextWindow = info.model_context_window;
        }
        const usage = info?.last_token_usage;
        if (positiveFinite(usage?.input_tokens)) return result(usage.input_tokens);
        if (
          (usage?.input_tokens === 0 || usage?.input_tokens === undefined) &&
          positiveFinite(usage?.total_tokens)
        ) {
          return result(usage.total_tokens);
        }
      } catch {}
    }
  }
  return result(0);
}
