import { execFile } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

/**
 * Read-only project tools for external MCP clients (requirements §3.1, §10):
 * every path is project-relative and resolved inside the project's real root,
 * sensitive files are invisible everywhere (listing, search, read, git), and
 * every answer is bounded and paginated. Output text is data — it never grants
 * anything, and secret-looking values are masked.
 */

const run = promisify(execFile);

const LIMITS = {
  readLines: 400,
  readBytes: 64 * 1024,
  searchResults: 100,
  searchFileBytes: 1024 * 1024,
  searchTotalBytes: 200 * 1024 * 1024,
  searchMs: 10_000,
  statusFiles: 500,
  diffFiles: 20,
  diffBytes: 64 * 1024,
  listEntries: 200,
} as const;

/** Never shown to MCP clients, in addition to the project's `.aiignore`. */
const SENSITIVE = [
  '.env',
  '.env.*',
  '!.env.example',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.kdbx',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.ssh/',
  '.aws/',
  '.gnupg/',
  '.docker/config.json',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'service-account*.json',
  '*.mobileprovision',
  '.git/',
];
/** Walked past without a look (generated or vendored), for search and listing. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'Library',
  '.next',
  '.venv',
]);

export class ProjectToolError extends Error {}

/** gitignore-style rules: `*`, `**`, `?`, trailing `/` = directory, leading `/` = anchored, `!` re-includes. */
export function compileIgnore(
  patterns: readonly string[],
): (path: string, dir: boolean) => boolean {
  const rules = patterns
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#'))
    .map((raw) => {
      const negate = raw.startsWith('!');
      let p = negate ? raw.slice(1) : raw;
      const dirOnly = p.endsWith('/');
      if (dirOnly) p = p.slice(0, -1);
      const anchored = p.startsWith('/') || p.includes('/');
      if (p.startsWith('/')) p = p.slice(1);
      let re = '';
      for (let i = 0; i < p.length; i++) {
        const c = p[i] as string;
        if (c === '*' && p[i + 1] === '*') {
          re += '.*';
          i++;
          if (p[i + 1] === '/') i++;
        } else if (c === '*') re += '[^/]*';
        else if (c === '?') re += '[^/]';
        else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
      const body = anchored ? `^${re}` : `(^|/)${re}`;
      return { negate, dirOnly, re: new RegExp(`${body}$`, 'i') };
    });
  // A path is hidden when a rule matches it or any directory above it; the last rule wins.
  return (path, dir) => {
    const segs = path.split('/').filter(Boolean);
    let hit = false;
    for (const r of rules)
      for (let i = 0; i < segs.length; i++) {
        const isDir = i < segs.length - 1 || dir;
        if ((!r.dirOnly || isDir) && r.re.test(segs.slice(0, i + 1).join('/'))) {
          hit = !r.negate;
          break;
        }
      }
    return hit;
  };
}

const mask = (text: string): string =>
  text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      '[redacted private key]',
    )
    .replace(/(Bearer\s+)[\w.+/=-]{8,}/gi, '$1[redacted]')
    .replace(
      /\b(sk-[\w-]{16,}|gh[pousr]_\w{16,}|xox[abpr]-[\w-]{10,}|AKIA[0-9A-Z]{16})\b/g,
      '[redacted]',
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
      '$1[redacted]',
    );

function isBinary(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

export class ProjectTools {
  private readonly ignores = new Map<
    string,
    { at: number; test: (p: string, dir: boolean) => boolean }
  >();

  /** `root` must already be the project's realpath (ExternalConversations keeps them so). */
  constructor(private readonly root: (projectId: string) => string) {}

  private hidden(projectId: string, rel: string, dir: boolean): boolean {
    const root = this.root(projectId);
    const file = join(root, '.aiignore');
    const at = existsSync(file) ? statSync(file).mtimeMs : 0;
    let cached = this.ignores.get(projectId);
    if (!cached || cached.at !== at) {
      const extra = at ? readFileSync(file, 'utf8').split('\n') : [];
      cached = { at, test: compileIgnore([...SENSITIVE, ...extra]) };
      this.ignores.set(projectId, cached);
    }
    return cached.test(rel.split(sep).join('/'), dir);
  }

  /** Whether a project-relative path is hidden from external clients. */
  restricted(projectId: string, rel: string): boolean {
    return this.hidden(projectId, rel, false);
  }

  /** Project-relative path → real absolute path, refusing escapes and hidden files. */
  resolve(projectId: string, rel: string): { abs: string; rel: string } {
    const root = this.root(projectId);
    if (typeof rel !== 'string' || rel.includes('\0') || isAbsolute(rel))
      throw new ProjectToolError('path must be relative to the project root');
    let abs: string;
    try {
      abs = realpathSync(join(root, rel || '.'));
    } catch {
      throw new ProjectToolError('path not found');
    }
    const inside = relative(root, abs);
    if (inside.startsWith('..') || isAbsolute(inside))
      throw new ProjectToolError('path is outside the project');
    const dir = statSync(abs).isDirectory();
    const clean = inside.split(sep).join('/');
    if (clean && this.hidden(projectId, clean, dir))
      throw new ProjectToolError('path is restricted (sensitive or listed in .aiignore)');
    return { abs, rel: clean };
  }

  readFile(projectId: string, path: string, startLine = 1, endLine?: number) {
    const { abs, rel } = this.resolve(projectId, path);
    const st = statSync(abs);
    if (st.isDirectory()) return this.listDir(projectId, rel);
    if (isBinary(abs)) throw new ProjectToolError('binary file; read_file returns text only');
    const lines = readFileSync(abs, 'utf8').split('\n');
    const start = Math.max(1, Math.floor(startLine));
    const want = Math.min(endLine ?? start + LIMITS.readLines - 1, start + LIMITS.readLines - 1);
    const out: string[] = [];
    let bytes = 0;
    let last = start - 1;
    for (let n = start; n <= Math.min(want, lines.length); n++) {
      const row = `${n}\t${lines[n - 1]}`;
      bytes += Buffer.byteLength(row) + 1;
      if (out.length && bytes > LIMITS.readBytes) break;
      out.push(row);
      last = n;
    }
    return {
      path: rel,
      total_lines: lines.length,
      start_line: start,
      end_line: last,
      next_start_line: last < lines.length ? last + 1 : null,
      text: mask(out.join('\n')),
    };
  }

  listDir(projectId: string, path = '') {
    const { abs, rel } = this.resolve(projectId, path);
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((e) => {
        const p = rel ? `${rel}/${e.name}` : e.name;
        return !this.hidden(projectId, p, e.isDirectory());
      })
      .sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      );
    return {
      path: rel,
      entries: entries
        .slice(0, LIMITS.listEntries)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name)),
      truncated: entries.length > LIMITS.listEntries,
    };
  }

  private async git(
    projectId: string,
    args: string[],
    maxBuffer = 8 * 1024 * 1024,
  ): Promise<string> {
    const { stdout } = await run('git', ['-c', 'core.quotepath=off', '--no-pager', ...args], {
      cwd: this.root(projectId),
      maxBuffer,
      timeout: 15_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  }

  private async files(projectId: string, prefix: string): Promise<string[]> {
    const { rel } = this.resolve(projectId, prefix);
    try {
      const out = await this.git(projectId, [
        'ls-files',
        '-co',
        '--exclude-standard',
        '-z',
        '--',
        rel || '.',
      ]);
      return out.split('\0').filter(Boolean);
    } catch {
      // not a git repository: walk, skipping generated and vendored directories
      const found: string[] = [];
      const walk = (dir: string) => {
        for (const e of readdirSync(join(this.root(projectId), dir), { withFileTypes: true })) {
          const p = dir ? `${dir}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name) && found.length < 50_000) walk(p);
          } else if (e.isFile()) found.push(p);
        }
      };
      walk(rel);
      return found;
    }
  }

  async searchCode(
    projectId: string,
    q: {
      query: string;
      regex?: boolean;
      path_prefix?: string;
      glob?: string;
      max_results?: number;
      cursor?: number;
    },
  ) {
    if (!q.query) throw new ProjectToolError('query is required');
    let matcher: RegExp;
    try {
      matcher = q.regex
        ? new RegExp(q.query, 'i')
        : new RegExp(q.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch {
      throw new ProjectToolError('invalid regular expression');
    }
    const glob = q.glob ? compileIgnore([q.glob]) : undefined;
    const limit = Math.min(Math.max(1, q.max_results ?? 30), LIMITS.searchResults);
    const skip = Math.max(0, q.cursor ?? 0);
    const root = this.root(projectId);
    const started = Date.now();
    const matches: { path: string; line: number; text: string }[] = [];
    let seen = 0;
    let scanned = 0;
    let complete = true;
    for (const file of await this.files(projectId, q.path_prefix ?? '')) {
      if (this.hidden(projectId, file, false) || (glob && !glob(file, false))) continue;
      if (Date.now() - started > LIMITS.searchMs || scanned > LIMITS.searchTotalBytes) {
        complete = false;
        break;
      }
      const abs = join(root, file);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > LIMITS.searchFileBytes || isBinary(abs)) continue;
      scanned += st.size;
      const lines = readFileSync(abs, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!matcher.test(lines[i] as string)) continue;
        if (seen++ < skip) continue;
        matches.push({
          path: file,
          line: i + 1,
          text: mask((lines[i] as string).trim().slice(0, 240)),
        });
        if (matches.length >= limit) {
          return { matches, next_cursor: skip + matches.length, complete: false };
        }
      }
    }
    return { matches, next_cursor: null, complete };
  }

  async gitStatus(projectId: string) {
    let out: string;
    try {
      out = await this.git(projectId, ['status', '--porcelain=v2', '--branch', '-z']);
    } catch {
      throw new ProjectToolError('not a git repository');
    }
    const info: Record<string, string> = {};
    const files: { path: string; status: string }[] = [];
    let hiddenCount = 0;
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i] as string;
      if (!line) continue;
      if (line.startsWith('# ')) {
        const [k, ...v] = line.slice(2).split(' ');
        info[k as string] = v.join(' ');
        continue;
      }
      const kind = line[0];
      let path = '';
      let status = '';
      if (kind === '1') {
        const f = line.split(' ');
        status = f[1] as string;
        path = f.slice(8).join(' ');
      } else if (kind === '2') {
        const f = line.split(' ');
        status = `${f[1]} renamed`;
        path = f.slice(9).join(' ');
        i++; // the original path follows
      } else if (kind === 'u') {
        status = 'conflict';
        path = line.split(' ').slice(10).join(' ');
      } else if (kind === '?') {
        status = 'untracked';
        path = line.slice(2);
      } else continue;
      if (this.hidden(projectId, path, false)) {
        hiddenCount++;
        continue;
      }
      files.push({ path, status });
    }
    const ab = /\+(\d+) -(\d+)/.exec(info['branch.ab'] ?? '');
    return {
      branch: info['branch.head'] ?? '',
      head: (info['branch.oid'] ?? '').slice(0, 12),
      upstream: info['branch.upstream'] ?? null,
      ahead: ab ? Number(ab[1]) : null,
      behind: ab ? Number(ab[2]) : null,
      dirty: files.length + hiddenCount > 0,
      files: files.slice(0, LIMITS.statusFiles),
      truncated: files.length > LIMITS.statusFiles,
      restricted_files: hiddenCount,
    };
  }

  async gitDiff(
    projectId: string,
    q: {
      base_ref?: string;
      head_ref?: string;
      path_prefix?: string;
      cursor?: number;
      staged?: boolean;
    },
  ) {
    const ref = (r: string | undefined) => {
      if (r === undefined) return undefined;
      if (!/^[\w./~^@{}-]{1,200}$/.test(r) || r.startsWith('-'))
        throw new ProjectToolError(`invalid ref: ${r}`);
      return r;
    };
    const base = ref(q.base_ref);
    const head = ref(q.head_ref);
    if (head && !base) throw new ProjectToolError('head_ref needs base_ref');
    const { rel } = this.resolve(projectId, q.path_prefix ?? '');
    const range = [
      ...(q.staged ? ['--cached'] : []),
      ...(base ? [base] : []),
      ...(head ? [head] : []),
    ];
    let names: string;
    try {
      names = await this.git(projectId, [
        'diff',
        '--name-status',
        '-z',
        ...range,
        '--',
        rel || '.',
      ]);
    } catch (e) {
      throw new ProjectToolError(`git diff failed: ${(e as Error).message.split('\n')[0]}`);
    }
    const parts = names.split('\0').filter(Boolean);
    const changed: { path: string; status: string }[] = [];
    for (let i = 0; i < parts.length; i++) {
      const status = parts[i] as string;
      const step = status.startsWith('R') || status.startsWith('C') ? 2 : 1; // renames list old and new
      i += step;
      const path = parts[i];
      if (path && !this.hidden(projectId, path, false)) changed.push({ path, status });
    }
    const start = Math.max(0, q.cursor ?? 0);
    const page = changed.slice(start, start + LIMITS.diffFiles);
    const files: { path: string; status: string; patch: string; truncated: boolean }[] = [];
    let bytes = 0;
    for (const f of page) {
      let patch = await this.git(projectId, ['diff', '--no-color', ...range, '--', f.path]).catch(
        () => '',
      );
      const remaining = LIMITS.diffBytes - bytes;
      if (files.length && remaining <= 0) break;
      const truncated = Buffer.byteLength(patch) > remaining;
      if (truncated) patch = `${patch.slice(0, Math.max(remaining, 2048))}\n[... truncated ...]`;
      bytes += Buffer.byteLength(patch);
      files.push({ ...f, patch: mask(patch), truncated });
    }
    const next = start + files.length;
    return {
      base_ref: base ?? (q.staged ? 'HEAD' : 'index'),
      head_ref: head ?? (q.staged ? 'index' : 'working tree'),
      total_files: changed.length,
      files,
      next_cursor: next < changed.length ? next : null,
    };
  }

  async context(projectId: string) {
    const root = this.root(projectId);
    const has = (p: string) => existsSync(join(root, p)) && !this.hidden(projectId, p, false);
    const stack: string[] = [];
    if (has('package.json')) {
      try {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
          name?: string;
          scripts?: Record<string, string>;
          workspaces?: unknown;
        };
        stack.push(
          `node${pkg.name ? ` (${pkg.name})` : ''}${pkg.scripts ? `: scripts ${Object.keys(pkg.scripts).slice(0, 12).join(', ')}` : ''}`,
        );
      } catch {
        stack.push('node');
      }
    }
    if (has('pnpm-workspace.yaml')) stack.push('pnpm workspace');
    if (has('Cargo.toml')) stack.push('rust');
    if (has('go.mod')) stack.push('go');
    if (has('pyproject.toml') || has('requirements.txt')) stack.push('python');
    if (has('ProjectSettings/ProjectVersion.txt')) stack.push('unity');
    if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) stack.push('jvm');
    const ai = has('.ai') ? this.listDir(projectId, '.ai').entries : [];
    const git = await this.gitStatus(projectId).catch(() => undefined);
    return {
      name: basename(root),
      root,
      stack,
      top_level: this.listDir(projectId, '').entries,
      ai_files: ai,
      docs: ['README.md', 'CLAUDE.md', 'AGENTS.md', 'docs/OVERVIEW.md'].filter(has),
      git: git
        ? { branch: git.branch, head: git.head, dirty: git.dirty, changed_files: git.files.length }
        : null,
    };
  }
}
