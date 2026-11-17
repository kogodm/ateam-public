import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { ateamHome } from './paths';

/**
 * Filesystem access for the in-app File view: list a directory, read a file
 * for preview (text or image), and write text back (editor save). Node has
 * full fs access in the sidecar, so this stays a thin, well-guarded wrapper.
 */

/** appended-to files, read from the end once they outgrow the cap */
const LOG_EXT = /\.(log|out|err)(\.\d+)?$/i;
const TEXT_CAP = 2 * 1024 * 1024; // 2 MB — beyond this, previewing text is silly
const IMAGE_CAP = 16 * 1024 * 1024; // 16 MB

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

// Extensions we confidently treat as text (edit-friendly). Anything not here
// is sniffed for NUL bytes before deciding.
const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.mdx',
  '.json',
  '.jsonc',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.xml',
  '.svg',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.sql',
  '.log',
  '.csv',
  '.tsv',
  '.gitignore',
  '.dockerignore',
  '.editorconfig',
  '.properties',
  '.gradle',
  '.lua',
  '.r',
  '.swift',
  '.dart',
  '.vue',
  '.svelte',
  '.graphql',
  '.proto',
]);

const TEXTLESS_NAMES = new Set([
  'dockerfile',
  'makefile',
  'license',
  'readme',
  'changelog',
  '.gitignore',
  '.env',
  '.dockerignore',
  '.editorconfig',
]);

export function resolveHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** First of the candidate paths that actually exists on disk, resolved
 *  absolute (~ expanded); null if none do. Used to resolve a relative path
 *  (e.g. a repo-relative terminal link) against several roots — the session
 *  cwd plus the project's attached Files-panel locations — and open the one
 *  that's really there instead of blindly joining the first root. */
/** Save an uploaded file under <ateamHome>/uploads — name sanitized, never
 *  overwriting (timestamp + random prefix), 0600. Used by phones to hand an
 *  image to a session running on this machine. */
export function saveUpload(name: string, base64: string): { path: string; bytes: number } {
  const safe =
    basename(name)
      .replace(/[^\w.\-()\u4e00-\u9fff ]+/g, '_')
      .slice(0, 120) || 'upload';
  const dir = join(ateamHome(), 'uploads');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const path = join(dir, `${stamp}-${randomBytes(3).toString('hex')}-${safe}`);
  const buf = Buffer.from(base64, 'base64');
  writeFileSync(path, buf, { mode: 0o600 });
  return { path, bytes: buf.length };
}

export function firstExistingPath(paths: string[]): { path: string | null } {
  for (const p of paths) {
    if (!p) continue;
    const abs = resolveHome(p);
    try {
      if (existsSync(abs)) return { path: abs };
    } catch {
      /* unreadable candidate — try the next */
    }
  }
  return { path: null };
}

/**
 * Create a project directory `<parent>/<name>` for the New-project flow.
 *
 * Deliberately strict, because this is the one RPC that WRITES a new path
 * from user input: `name` must be a single, plain segment (no separators, no
 * `..`, no leading dot) and `parent` must already exist — we never create a
 * whole tree from a typed string. An existing directory is NOT an error
 * (`created: false`): picking a folder you made a second ago should just
 * work. An existing FILE at that path is an error.
 */
export function createDir(
  parent: string,
  name: string,
): { dir: string | null; created: boolean; err?: string } {
  const trimmed = name.trim();
  if (!trimmed) return { dir: null, created: false, err: '目录名不能为空' };
  if (/[/\\]/.test(trimmed)) return { dir: null, created: false, err: '目录名不能包含路径分隔符' };
  if (trimmed === '.' || trimmed === '..') return { dir: null, created: false, err: '目录名无效' };
  if (trimmed.startsWith('.')) return { dir: null, created: false, err: '目录名不能以 . 开头' };
  const parentAbs = resolveHome(parent.trim());
  if (!parentAbs.startsWith('/'))
    return { dir: null, created: false, err: '上级目录必须是绝对路径' };
  try {
    if (!existsSync(parentAbs) || !statSync(parentAbs).isDirectory()) {
      return { dir: null, created: false, err: '上级目录不存在' };
    }
  } catch {
    return { dir: null, created: false, err: '上级目录不可读' };
  }
  const dir = join(parentAbs, trimmed);
  try {
    if (existsSync(dir)) {
      if (!statSync(dir).isDirectory()) return { dir: null, created: false, err: '同名文件已存在' };
      return { dir, created: false }; // already a directory — reuse it
    }
    mkdirSync(dir);
    return { dir, created: true };
  } catch (e) {
    return { dir: null, created: false, err: e instanceof Error ? e.message : String(e) };
  }
}

export function listDir(path: string): {
  path: string;
  parent?: string;
  entries: { name: string; path: string; dir: boolean; size: number }[];
} {
  const dir = resolveHome(path);
  const raw = readdirSync(dir, { withFileTypes: true });
  const entries = raw
    .map((e) => {
      const full = join(dir, e.name);
      let isDir = e.isDirectory();
      let size = 0;
      try {
        const st = statSync(full);
        isDir = st.isDirectory();
        size = st.size;
      } catch {
        /* broken symlink etc. */
      }
      return { name: e.name, path: full, dir: isDir, size };
    })
    .sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1; // dirs first
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  const parent = dirname(dir);
  return { path: dir, parent: parent === dir ? undefined : parent, entries };
}

function looksTextual(name: string, ext: string): boolean {
  if (TEXT_EXT.has(ext)) return true;
  const lower = name.toLowerCase();
  if (TEXTLESS_NAMES.has(lower)) return true;
  return ext === ''; // extensionless — sniff below
}

export function readFileForView(path: string): {
  path: string;
  kind: 'text' | 'image' | 'unsupported';
  text?: string;
  base64?: string;
  mime?: string;
  size: number;
  truncated?: boolean;
  /** the returned text is the END of an oversized log, not its start */
  fromEnd?: boolean;
  mtime?: string;
} {
  const full = resolveHome(path);
  const st = statSync(full);
  const size = st.size;
  const mtime = st.mtime.toISOString();
  const ext = extname(full).toLowerCase();
  const name = basename(full);

  const mime = IMAGE_MIME[ext];
  if (mime && ext !== '.svg') {
    if (size > IMAGE_CAP) return { path: full, kind: 'unsupported', size };
    return {
      path: full,
      kind: 'image',
      base64: readFileSync(full).toString('base64'),
      mime,
      size,
      mtime,
    };
  }

  if (looksTextual(name, ext) || ext === '.svg') {
    let buf: Buffer;
    let fromEnd = false;
    if (size > TEXT_CAP) {
      // A log is read from its END: the interesting part of a run that has
      // outgrown the cap is what happened last, and the head is where the
      // process was still starting up. Everything else keeps its head window.
      fromEnd = LOG_EXT.test(name);
      const fd = openSync(full, 'r');
      try {
        buf = Buffer.alloc(TEXT_CAP);
        const n = readSync(fd, buf, 0, TEXT_CAP, fromEnd ? size - TEXT_CAP : 0);
        buf = buf.subarray(0, n);
      } finally {
        closeSync(fd);
      }
      // a window taken mid-file almost certainly starts mid-line
      if (fromEnd) {
        const nl = buf.indexOf(0x0a);
        if (nl >= 0 && nl < 4096) buf = buf.subarray(nl + 1);
      }
    } else {
      buf = readFileSync(full);
    }
    // sniff for binary (NUL byte) in the read window when the extension is
    // ambiguous (extensionless files).
    if (ext === '' && buf.includes(0)) return { path: full, kind: 'unsupported', size };
    return {
      path: full,
      kind: 'text',
      text: buf.toString('utf8'),
      size,
      truncated: size > TEXT_CAP,
      ...(fromEnd ? { fromEnd: true } : {}),
    };
  }

  return { path: full, kind: 'unsupported', size };
}

export function writeFileText(path: string, text: string): { ok: boolean; err?: string } {
  try {
    writeFileSync(resolveHome(path), text, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}
