/**
 * Per-session index of the files an agent has actually touched, harvested from
 * its transcript — the cheap way to resolve a relative path printed in the
 * terminal.
 *
 * Why this exists: an agent that has `cd`'d into a subdirectory (or that simply
 * prefers short references) prints `src/app.ts`, and joining that to the
 * session cwd 404s. The obvious fix — search the filesystem for it — was tried
 * and removed (commit 689ca5a): a synchronous BFS on the sidecar's single
 * thread froze every RPC in the app.
 *
 * The observation that makes searching unnecessary: a path on screen is almost
 * always a file the agent just read or wrote, and claude records every
 * Read/Edit/Write with an ABSOLUTE `file_path` in the transcript we are already
 * tailing every 1.5s for turn events. So we keep the absolute paths as they go
 * by and answer later questions with a map lookup — no traversal, no stat
 * storms, nothing that can block.
 *
 * Coverage caveat: codex reads files through shell commands, so its rollout
 * carries far fewer structured paths. That is fine — codex is instructed to
 * cite workspace-relative paths, which resolve against the cwd anyway.
 */

/** most absolute paths kept per session (FIFO) — bounds a long session */
const MAX_PATHS = 2000;
/** how many distinct absolute paths we keep per basename */
const MAX_PER_NAME = 8;
/** JSON records can be megabytes of base64; bound the walk hard */
const MAX_DEPTH = 6;
const MAX_NODES = 400;
/** a plausible filesystem path, not a haystack of text that begins with '/' */
const MAX_PATH_LEN = 512;
/** working directories remembered per session (FIFO, most recent first) */
const MAX_DIRS = 64;
/** only the head of a command is scanned for `cd` — a heredoc body can be
 *  the whole file being written, and there is nothing to learn past the first
 *  few hundred characters */
const CMD_SCAN_LEN = 400;

/** In one left-to-right pass over a command: any `cd` (group 1 = its target,
 *  quoted or bare), or a file-looking argument (group 2) — at least one `/`
 *  and an extension, standing on its own after whitespace, a quote, `=`, `(`,
 *  or a redirect. `https://x/y.js` never matches: `:` is not a boundary. */
const CMD_TOKEN_RE =
  /\bcd\s+(?:"([^"\n]{1,500})"|'([^'\n]{1,500})'|([^\s;&|)]{1,500}))|(?<=^|[\s"'=(<>])((?:\.{1,2}\/|\/)?[\w@+-][\w.@+-]*(?:\/[\w.@+-]+)+\.[A-Za-z0-9]{1,8})(?=$|[\s"';|&)<>:,])/g;

/** Keys whose string value is a path worth remembering. Key-driven on purpose:
 *  "any string starting with /" would swallow prose out of tool results. */
const PATH_KEY_RE = /^(?:file_path|filePath|notebook_path|notebookPath|path|abs_path|absPath)$/;

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** `base` + a relative path, with `./` and `../` folded — no filesystem. */
function joinRel(base: string, rel: string): string {
  const parts = base.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 1) parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/') || '/';
}

/** Strip the noise a reference picks up in prose: `./` and git's `a/` `b/`
 *  diff prefixes (codex is explicitly told those are acceptable to emit).
 *  Only ever a FALLBACK interpretation — `b/` is also a perfectly ordinary
 *  directory name, so resolve() tries the reference verbatim first. */
export function normalizeRef(ref: string): string {
  return ref.replace(/^\.\//, '').replace(/^[ab]\//, '');
}

export class SessionPathIndex {
  /** basename → absolute paths, most recently seen first */
  private readonly byName = new Map<string, string[]>();
  /** insertion order, for capping */
  private readonly order: string[] = [];
  private lastCwd?: string;
  /** Directories this session has demonstrably worked in, most recent first.
   *  Two sources: the parent of every absolute path we harvest, and any
   *  `cd /abs` inside a shell command. The second is the one that matters —
   *  a file written by `cd <dir> && cat > docs/x.md <<EOF` leaves no
   *  file_path anywhere, so the ONLY record of where it landed is that cd.
   *  Without this, clicking such a path offers the session cwd, which is not
   *  where the agent was standing. */
  private readonly workDirs: string[] = [];

  /** The working directory the agent last reported. Every claude record
   *  carries one, so this follows the session even when it moves. */
  cwd(): string | undefined {
    return this.lastCwd;
  }

  size(): number {
    return this.order.length;
  }

  /** Directories worth joining a relative reference against, best first. */
  dirs(): string[] {
    return [...this.workDirs];
  }

  noteDir(abs: string): void {
    if (!abs.startsWith('/') || abs.length > MAX_PATH_LEN || abs.includes('\n')) return;
    const dir = abs.replace(/\/+$/, '');
    if (!dir) return;
    const at = this.workDirs.indexOf(dir);
    if (at >= 0) this.workDirs.splice(at, 1);
    this.workDirs.unshift(dir);
    if (this.workDirs.length > MAX_DIRS) this.workDirs.length = MAX_DIRS;
  }

  add(abs: string): void {
    if (!abs.startsWith('/') || abs.length > MAX_PATH_LEN || abs.includes('\n')) return;
    const name = basename(abs);
    if (!name) return;
    const list = this.byName.get(name) ?? [];
    const at = list.indexOf(abs);
    if (at >= 0) list.splice(at, 1); // re-seen → move to front
    else this.order.push(abs);
    list.unshift(abs);
    if (list.length > MAX_PER_NAME) list.length = MAX_PER_NAME;
    this.byName.set(name, list);
    const parent = abs.slice(0, abs.length - name.length - 1);
    if (parent) this.noteDir(parent);
    while (this.order.length > MAX_PATHS) {
      const evicted = this.order.shift();
      if (!evicted) break;
      const l = this.byName.get(basename(evicted));
      if (!l) continue;
      const i = l.indexOf(evicted);
      if (i >= 0) l.splice(i, 1);
      if (l.length === 0) this.byName.delete(basename(evicted));
    }
  }

  /** Harvest one raw transcript line (JSONL). Malformed lines are ignored —
   *  the tailer hands us partial records at chunk boundaries. */
  noteLine(line: string): void {
    const t = line.trim();
    if (!t.startsWith('{')) return;
    try {
      this.noteRecord(JSON.parse(t));
    } catch {
      /* partial or non-JSON line */
    }
  }

  noteRecord(rec: unknown): void {
    let nodes = 0;
    // the shell a command ran in stood at the record's cwd — needed to anchor
    // the relative paths inside that command
    const recCwd =
      rec && typeof rec === 'object' && typeof (rec as { cwd?: unknown }).cwd === 'string'
        ? (rec as { cwd: string }).cwd
        : undefined;
    const walk = (value: unknown, key: string, depth: number): void => {
      if (nodes++ > MAX_NODES || depth > MAX_DEPTH) return;
      if (typeof value === 'string') {
        if (key === 'cwd') {
          if (value.startsWith('/') && value.length <= MAX_PATH_LEN) this.lastCwd = value;
        } else if (PATH_KEY_RE.test(key)) {
          this.add(value);
        } else if (key === 'command') {
          this.noteShellCommand(value, recCwd);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const v of value) walk(v, key, depth + 1);
        return;
      }
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, k, depth + 1);
      }
    };
    walk(rec, '', 0);
  }

  /** Learn from a shell command where it was standing and which files it
   *  named. Only `cd` to an absolute path moves us: a relative `cd` needs the
   *  shell's state to interpret, which we do not have, and guessing at it would
   *  point clicks somewhere plausible and wrong — so after one, the relative
   *  paths that follow are dropped too.
   *
   *  File arguments matter because an agent that inspects a file with
   *  `grep … prompts/x/request.txt` leaves no file_path anywhere; later it
   *  cites `x/request.txt`, and without this the click has nothing to go on.
   *  Nothing is stat'ed here — resolve()'s caller checks existence. */
  noteShellCommand(cmd: string, cwd?: string): void {
    const head = cmd.length > CMD_SCAN_LEN ? cmd.slice(0, CMD_SCAN_LEN) : cmd;
    let base = cwd?.startsWith('/') ? cwd.replace(/\/+$/, '') : undefined;
    CMD_TOKEN_RE.lastIndex = 0;
    for (let m = CMD_TOKEN_RE.exec(head); m; m = CMD_TOKEN_RE.exec(head)) {
      const dir = m[1] ?? m[2] ?? m[3];
      if (dir !== undefined) {
        if (dir.startsWith('/')) {
          this.noteDir(dir);
          base = dir.replace(/\/+$/, '');
        } else base = undefined;
        continue;
      }
      const file = m[4];
      if (!file) continue;
      if (file.startsWith('/')) this.add(file);
      else if (base) this.add(joinRel(base, file));
    }
  }

  /**
   * Absolute candidates for a reference seen in the terminal, best first:
   * paths whose tail matches the whole reference beat ones that merely share
   * its filename, and within each group the most recently touched wins.
   */
  resolve(ref: string): string[] {
    const asIs = ref.replace(/^\.\//, '');
    if (!asIs) return [];
    const direct = this.tailMatches(asIs);
    if (direct.length > 0) return direct;
    // only now read a leading `a/` `b/` as git's diff prefix rather than as
    // a real directory — a repo that genuinely has b/ must win over the guess
    const stripped = normalizeRef(asIs);
    if (stripped !== asIs) {
      const viaDiffPrefix = this.tailMatches(stripped);
      if (viaDiffPrefix.length > 0) return viaDiffPrefix;
    }
    // last resort: the same filename somewhere else entirely
    return [...(this.byName.get(basename(asIs)) ?? [])];
  }

  /** Indexed paths that END with the whole reference. */
  private tailMatches(ref: string): string[] {
    const list = this.byName.get(basename(ref));
    if (!list || list.length === 0) return [];
    const tail = `/${ref}`;
    return list.filter((p) => p === ref || p.endsWith(tail));
  }
}
