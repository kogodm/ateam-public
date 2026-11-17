import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { claudeProjectDir } from './claude-sessions';
import { isTaskId, sessionTasksDir } from './tasks-dir';

/**
 * Commands the session left running in the background.
 *
 * They share a directory with the sub-agents' conversations but nothing else:
 * a sub-agent's file is a transcript jsonl, a backgrounded command's is just
 * the command's own stdout, growing until it stops. That is the whole
 * difference the reader needs, so it is also how they are told apart — a file
 * whose first line does not parse as a sidechain record is a shell.
 *
 * Whether one is still running is answered by the file, not by a process
 * lookup: the harness appends `[exited with code N]` when the command ends, so
 * the absence of that line at the tail IS "still going". No pid to chase, and
 * it stays true for a session restored after a restart.
 */

export interface BgShellInfo {
  id: string;
  /** false while the command is still producing output */
  done: boolean;
  exitCode?: number;
  bytes: number;
  /** ISO of the last write — how long it has been quiet */
  lastAt: string;
  /** first line of output, for a one-glance idea of what it is doing */
  head: string;
  /** when the task's output file was created — the command's start */
  startedAtMs?: number;
}

const EXIT_RE = /\[exited with code (-?\d+)\]\s*$/;
/** a task stopped from outside (TaskStop / kill) ends with this instead */
const KILLED_RE = /\[killed\]\s*$/;
/** Enough of the tail to hold the exit marker and a line or two before it. */
const TAIL_PROBE = 4096;
/** What a viewer gets by default. A build log can be megabytes; the end is
 *  what anyone actually wants, and it is what fits on a phone. */
export const BG_TAIL_BYTES = 64 * 1024;

function readTail(
  path: string,
  bytes: number,
): { text: string; size: number; took: number; mtimeMs: number } {
  let fd: number | undefined;
  try {
    const st = statSync(path);
    const size = st.size;
    const take = Math.min(bytes, size);
    const buf = Buffer.alloc(take);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, take, Math.max(0, size - take));
    // Cutting at a byte offset lands mid-character in any non-ASCII output,
    // and mid-line always. When there IS more above, drop the partial first
    // line — a clean start beats a replacement character and half a word.
    let text = buf.toString('utf8');
    if (take < size) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return { text, size, took: take, mtimeMs: st.mtimeMs };
  } catch {
    return { text: '', size: 0, took: 0, mtimeMs: 0 };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

function firstLine(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(2048);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.indexOf(0x0a);
    return buf
      .subarray(0, nl >= 0 && nl < n ? nl : n)
      .toString('utf8')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/** A sub-agent's log opens with a JSON record; a shell's does not. */
function looksLikeSubagent(path: string): boolean {
  const line = firstLine(path);
  if (!line.startsWith('{')) return false;
  try {
    const rec = JSON.parse(line.endsWith('}') ? line : `${line}}`) as { isSidechain?: unknown };
    return rec?.isSidechain === true;
  } catch {
    // a truncated first line of a jsonl still starts with {"parentUuid"… —
    // treat that as a sub-agent rather than showing a wall of JSON as "output"
    return line.includes('"isSidechain"');
  }
}

/** the marker as a line of its own ANYWHERE in the tail: a command that timed
 *  out and was moved to the background gets `[exited with code 144]` while
 *  its process can still print after it (b0j90aiu7, 09-15) */
const EXIT_LINE_RE = /^\[exited with code (-?\d+)\]$/gm;
const KILLED_LINE_RE = /^\[killed\]$/m;

function statusOf(path: string, persisted: boolean): { done: boolean; exitCode?: number } {
  const { text } = readTail(path, TAIL_PROBE);
  const m = [...text.matchAll(EXIT_LINE_RE)].at(-1);
  if (m?.[1]) return { done: true, exitCode: Number(m[1]) };
  if (KILLED_LINE_RE.test(text)) return { done: true };
  // A FOREGROUND command whose output was too big gets a task file too, and
  // never an exit marker — but claude saved that output beside the transcript
  // when the command returned. Unmarked + saved = finished, not running.
  return { done: persisted };
}

/** claude's copy of a finished foreground command's oversized output */
function persistedOutput(cwd: string, claudeSessionId: string, id: string): boolean {
  return existsSync(join(claudeProjectDir(cwd), claudeSessionId, 'tool-results', `${id}.txt`));
}

/** Every backgrounded command of this session, still running first. */
export function listBackgroundShells(cwd: string, claudeSessionId: string): BgShellInfo[] {
  const dir = sessionTasksDir(cwd, claudeSessionId);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: BgShellInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.output')) continue;
    const id = name.slice(0, -'.output'.length);
    if (!isTaskId(id)) continue;
    const path = join(dir, name);
    if (looksLikeSubagent(path)) continue;
    let bytes = 0;
    let lastAt = '';
    let startedAtMs: number | undefined;
    try {
      const st = statSync(path);
      bytes = st.size;
      lastAt = st.mtime.toISOString();
      // birthtime is 0 where the filesystem does not keep one
      if (st.birthtimeMs > 0) startedAtMs = st.birthtimeMs;
    } catch {
      continue; // vanished between readdir and stat
    }
    out.push({
      id,
      ...statusOf(path, persistedOutput(cwd, claudeSessionId, id)),
      bytes,
      lastAt,
      head: firstLine(path),
      ...(startedAtMs ? { startedAtMs } : {}),
    });
  }
  // still running first, then most recently written
  return out.sort((a, b) => Number(a.done) - Number(b.done) || (a.lastAt < b.lastAt ? 1 : -1));
}

/** The tail of one backgrounded command's output. */
export function readBackgroundShell(
  cwd: string,
  claudeSessionId: string,
  id: string,
  tailBytes = BG_TAIL_BYTES,
  /** the file the command redirected its output to, when it did — read
   *  instead of the (then empty) task output; done-ness still comes from the
   *  task output's exit marker */
  logPath?: string,
): {
  text: string;
  bytes: number;
  truncated: boolean;
  done: boolean;
  exitCode?: number;
  logPath?: string;
  /** when what was read was last written */
  mtimeMs?: number;
} {
  if (!isTaskId(id)) return { text: '', bytes: 0, truncated: false, done: true };
  const path = join(sessionTasksDir(cwd, claudeSessionId), `${id}.output`);
  if (!existsSync(path)) return { text: '', bytes: 0, truncated: false, done: true };
  const cap = Math.min(Math.max(tailBytes, 1024), 1024 * 1024);
  const own = readTail(path, cap);
  // the task output holds nothing but the exit marker when stdout went elsewhere
  const useLog = !!logPath && own.text.replace(EXIT_RE, '').replace(KILLED_RE, '').trim() === '';
  const { text, size, took, mtimeMs } = useLog ? readTail(logPath as string, cap) : own;
  // compare BYTES with BYTES — text.length is characters, and any Chinese in
  // the output would have made a complete read look truncated
  return {
    text,
    bytes: size,
    truncated: took < size,
    ...(mtimeMs ? { mtimeMs } : {}),
    ...statusOf(path, persistedOutput(cwd, claudeSessionId, id)),
    ...(useLog ? { logPath } : {}),
  };
}
