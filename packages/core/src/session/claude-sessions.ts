import { closeSync, existsSync, openSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeSessionInfo } from '@ateam/contract';
import { getSessionOwners } from './session-owners';
import { claudeTitleFromPath } from './transcript-file';

/**
 * Lists prior Claude Code sessions for a cwd so an agent can resume one
 * (`claude --resume <id>`). Claude Code stores transcripts at
 * `~/.claude/projects/<slug>/<session-id>.jsonl`.
 *
 * Slug encoding (confirmed against real on-disk dirs): EVERY character that
 * isn't `[A-Za-z0-9]` collapses to `-` — not just `/`. Verified:
 *   /Users/sample/PycharmProjects/ATeam
 *     -> -Users-sample-PycharmProjects-ATeam        (case preserved)
 *   /Users/sample/projects/workspace/workspace_server_lambda
 *     -> -Users-sample-projects-workspace-workspace-server-lambda  (`_` -> `-`)
 * Earlier code only replaced `/`, so any path with `_`/`.` resolved to a
 * non-existent dir — breaking transcript reads, session-name, and reflect
 * for those projects.
 */
export function claudeProjectDir(cwd: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return join(homedir(), '.claude', 'projects', slug);
}
const projectDir = claudeProjectDir;

/**
 * Claude keeps one project-level pointer at
 * `<claudeProjectDir>/bridge-pointer.json`. While that file exists, the next
 * Claude process for this project attaches the remote history channel it
 * names. Remove only that local file, before the process starts, so this
 * launch has nothing to attach. Transcripts beside it stay. A missing file
 * is a no-op. The remote conversation and the model API are not touched.
 */
export function clearClaudeBridgePointer(cwd: string): void {
  if (!cwd) return;
  const path = join(claudeProjectDir(cwd), 'bridge-pointer.json');
  let isFile = false;
  try {
    isFile = statSync(path).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!isFile) return;
  rmSync(path);
}

/** Read only the first `bytes` of `file` and split into complete lines.
 *  Slurping the whole .jsonl is catastrophic — they can be tens of MB. */
function readHeadLines(file: string, bytes: number): string[] {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, len, 0);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (len < size) lines.pop(); // drop partial last line
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function summarize(file: string): string {
  try {
    const head = readHeadLines(file, 64 * 1024).slice(0, 50);
    for (const line of head) {
      try {
        const o = JSON.parse(line) as { type?: string; summary?: string };
        if (o.type === 'summary' && o.summary) return o.summary.replace(/\s+/g, ' ').slice(0, 80);
      } catch {
        /* skip non-JSON line */
      }
    }
    for (const line of head) {
      try {
        const o = JSON.parse(line) as {
          type?: string;
          message?: { role?: string; content?: unknown };
        };
        const msg = o.message;
        if (o.type === 'user' || msg?.role === 'user') {
          const c = msg?.content;
          const text =
            typeof c === 'string'
              ? c
              : Array.isArray(c)
                ? c
                    .map((x) => (x as { text?: string })?.text)
                    .filter(Boolean)
                    .join(' ')
                : '';
          if (text.trim()) return text.trim().replace(/\s+/g, ' ').slice(0, 80);
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* unreadable */
  }
  return '(no summary)';
}

export function listClaudeSessions(cwd: string, limit = 30): ClaudeSessionInfo[] {
  const dir = projectDir(cwd);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  // Stat-only pass: sort by mtime first, then enrich (title/summary touch
  // file IO) ONLY the top `limit` survivors. With dozens of transcripts
  // where the active one can be 64MB, this is the difference between
  // "instant" and "卡很久".
  type Row = { id: string; full: string; mtime: string };
  const rows: Row[] = files.map((f) => {
    const full = join(dir, f);
    let mtime = '';
    try {
      mtime = statSync(full).mtime.toISOString();
    } catch {
      /* ignore — sorts to the bottom */
    }
    return { id: f.slice(0, -'.jsonl'.length), full, mtime };
  });
  rows.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  const top = rows.slice(0, limit);
  const owners = getSessionOwners(top.map((r) => r.id));
  return top.map(({ id, full, mtime }) => ({
    id,
    mtime,
    title: claudeTitleFromPath(full),
    summary: summarize(full),
    humanId: owners[id],
  }));
}
