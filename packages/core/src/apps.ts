import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { IS_LINUX, IS_MAC, IS_WINDOWS, whichSync } from './platform';

/** A native app the user can pick as their "open project dir with" default.
 *  We probe the standard install locations per OS. */
export interface AppInfo {
  id: string;
  label: string;
  /** macOS: the .app bundle name (open -a <appName>).
   *  Windows: the .exe basename or registered command (start /B "" <exePath>).
   *  Linux: a desktop-file id or executable name (xdg-open / direct spawn). */
  appName: string;
  available: boolean;
}

interface Candidate {
  id: string;
  label: string;
  /** macOS LaunchServices name (without .app). */
  mac: string;
  /** macOS bundle filenames to probe under /Applications + ~/Applications.
   *  Defaults to `${mac}.app`. */
  macBundles?: string[];
  /** Windows .exe basenames to look up via PATH / well-known install dirs.
   *  First match wins. Empty = not available on Windows. */
  win?: string[];
  /** Linux executable names to look up via PATH. Empty = not on Linux. */
  linux?: string[];
  /** Always considered available (OS-supplied app). */
  systemApp?: boolean;
}

const CANDIDATES: Candidate[] = [
  {
    id: 'vscode',
    label: 'VS Code',
    mac: 'Visual Studio Code',
    win: ['Code.exe'],
    linux: ['code'],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    mac: 'Cursor',
    win: ['Cursor.exe'],
    linux: ['cursor'],
  },
  {
    id: 'sublime',
    label: 'Sublime Text',
    mac: 'Sublime Text',
    win: ['sublime_text.exe'],
    linux: ['subl'],
  },
  { id: 'finder', label: 'Finder', mac: 'Finder', systemApp: true },
  {
    id: 'explorer',
    label: 'Explorer',
    mac: '',
    win: ['explorer.exe'],
    systemApp: true,
  },
  { id: 'terminal', label: 'Terminal', mac: 'Terminal', systemApp: true },
  {
    id: 'iterm',
    label: 'iTerm2',
    mac: 'iTerm',
    macBundles: ['iTerm.app', 'iTerm2.app'],
  },
  { id: 'xcode', label: 'Xcode', mac: 'Xcode' },
  {
    id: 'androidstudio',
    label: 'Android Studio',
    mac: 'Android Studio',
    win: ['studio64.exe'],
    linux: ['studio.sh'],
  },
  {
    id: 'intellij',
    label: 'IntelliJ IDEA',
    mac: 'IntelliJ IDEA',
    macBundles: ['IntelliJ IDEA.app', 'IntelliJ IDEA CE.app'],
    win: ['idea64.exe'],
    linux: ['idea'],
  },
  {
    id: 'pycharm',
    label: 'PyCharm',
    mac: 'PyCharm',
    macBundles: ['PyCharm.app', 'PyCharm CE.app'],
    win: ['pycharm64.exe'],
    linux: ['pycharm'],
  },
  {
    id: 'webstorm',
    label: 'WebStorm',
    mac: 'WebStorm',
    win: ['webstorm64.exe'],
    linux: ['webstorm'],
  },
  {
    id: 'goland',
    label: 'GoLand',
    mac: 'GoLand',
    win: ['goland64.exe'],
    linux: ['goland'],
  },
  {
    id: 'rider',
    label: 'Rider',
    mac: 'Rider',
    win: ['rider64.exe'],
    linux: ['rider'],
  },
];

function macBundleExists(name: string): boolean {
  const home = process.env.HOME ?? '';
  return (
    existsSync(join('/Applications', name)) ||
    (!!home && existsSync(join(home, 'Applications', name)))
  );
}

/** Probe common Windows install roots for an exe basename. PATH lookup
 *  comes first (whichSync); this is the fallback for IDEs that don't
 *  put themselves on PATH (most JetBrains do not by default). */
function winInstalledPath(exe: string): string | undefined {
  const roots = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.PROGRAMW6432,
  ].filter((v): v is string => !!v);
  for (const root of roots) {
    // shallow 2-level scan — IDE installs typically sit as
    // <root>/<Vendor>/<Product>/bin/<exe>
    const direct = join(root, exe);
    if (existsSync(direct)) return direct;
    try {
      // best-effort one-level scan; we don't recurse fully to avoid IO storms
      for (const child of readdirSync(root)) {
        const a = join(root, child, exe);
        if (existsSync(a)) return a;
        const b = join(root, child, 'bin', exe);
        if (existsSync(b)) return b;
      }
    } catch {
      /* unreadable root */
    }
  }
  return undefined;
}

export function listOpenerApps(): AppInfo[] {
  return CANDIDATES.flatMap((c): AppInfo[] => {
    if (IS_MAC) {
      if (!c.mac && !c.systemApp) return []; // not advertised on this OS
      const bundles = c.macBundles ?? (c.mac ? [`${c.mac}.app`] : []);
      const available = c.systemApp || bundles.some(macBundleExists);
      const appName = c.mac || c.label;
      return [{ id: c.id, label: c.label, appName, available }];
    }
    if (IS_WINDOWS) {
      if (!c.win?.length && !c.systemApp) return [];
      let appName = c.win?.[0] ?? '';
      let available = c.systemApp ?? false;
      for (const exe of c.win ?? []) {
        const p = whichSync(exe) ?? winInstalledPath(exe);
        if (p) {
          appName = p; // absolute path is the most reliable thing to launch
          available = true;
          break;
        }
      }
      return [{ id: c.id, label: c.label, appName, available }];
    }
    if (IS_LINUX) {
      if (!c.linux?.length && !c.systemApp) return [];
      let appName = c.linux?.[0] ?? '';
      let available = c.systemApp ?? false;
      for (const bin of c.linux ?? []) {
        const p = whichSync(bin);
        if (p) {
          appName = p;
          available = true;
          break;
        }
      }
      return [{ id: c.id, label: c.label, appName, available }];
    }
    return [];
  });
}

/** Locate a candidate's .app bundle on disk, including the system app
 *  homes (Finder lives in CoreServices, Terminal under /System/…/Utilities). */
function macBundlePath(c: Candidate): string | undefined {
  const home = process.env.HOME ?? '';
  const names = c.macBundles ?? (c.mac ? [`${c.mac}.app`] : []);
  const roots = [
    '/Applications',
    home && join(home, 'Applications'),
    '/System/Applications',
    '/System/Applications/Utilities',
    '/System/Library/CoreServices',
  ].filter(Boolean) as string[];
  for (const n of names) {
    for (const r of roots) {
      const p = join(r, n);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/** id → 64px PNG base64 ('' = no icon). Cached for the sidecar's lifetime —
 *  the icns→png conversion (sips) runs once per app. macOS only. */
const iconCache = new Map<string, string>();

async function appIconPng(c: Candidate): Promise<string> {
  const hit = iconCache.get(c.id);
  if (hit !== undefined) return hit;
  let png = '';
  if (IS_MAC) {
    const bundle = macBundlePath(c);
    if (bundle) {
      // CFBundleIconFile via `defaults read` (copes with binary plists);
      // fall back to the first .icns in Resources when unset (rare).
      let icns = '';
      try {
        icns = execFileSync('defaults', ['read', join(bundle, 'Contents', 'Info'), 'CFBundleIconFile'], {
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2000,
        })
          .toString()
          .trim();
      } catch {
        /* key absent */
      }
      const res = join(bundle, 'Contents', 'Resources');
      let icnsPath = icns
        ? join(res, icns.endsWith('.icns') ? icns : `${icns}.icns`)
        : '';
      if (!icnsPath || !existsSync(icnsPath)) {
        try {
          const first = readdirSync(res).find((f) => f.endsWith('.icns'));
          icnsPath = first ? join(res, first) : '';
        } catch {
          icnsPath = '';
        }
      }
      if (icnsPath) {
        const out = join(tmpdir(), `ateam-appicon-${c.id}.png`);
        await new Promise<void>((done) => {
          execFile(
            'sips',
            ['-s', 'format', 'png', '-Z', '64', icnsPath, '--out', out],
            { timeout: 5000 },
            () => done(),
          );
        });
        try {
          png = readFileSync(out).toString('base64');
        } catch {
          png = '';
        }
      }
    }
  }
  iconCache.set(c.id, png);
  return png;
}

/** All resolvable app icons keyed by candidate id (base64 64px PNG). */
export async function listAppIcons(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    CANDIDATES.map(async (c) => {
      const png = await appIconPng(c);
      if (png) out[c.id] = png;
    }),
  );
  return out;
}

/** Expand `~/…` and resolve a relative path against `cwd` (or process.cwd()
 *  if none given). Pure — the caller decides what to do if it doesn't exist. */
function resolveOpenPath(path: string, cwd?: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  if (isAbsolute(path)) return path;
  return resolve(cwd ?? process.cwd(), path);
}

/** Open a filesystem path with the given app. Branches per-OS:
 *   • macOS:   `open -a <appName> <path>`
 *   • Windows: `cmd /c start "" "<appName>" "<path>"` (start handles both
 *              exe paths and well-known commands like "explorer"). The
 *              empty "" is the window title argument that `start` requires.
 *   • Linux:   if `appName` is a file path or executable, spawn it directly
 *              with the path as argv[1]; else fall back to `xdg-open <path>`. */
export function openWithApp(
  appName: string,
  path: string,
  cwd?: string,
): Promise<{ ok: boolean; err?: string }> {
  const abs = resolveOpenPath(path, cwd);
  if (!existsSync(abs)) {
    return Promise.resolve({ ok: false, err: `no such path: ${abs}` });
  }
  return new Promise((resolveP) => {
    const argv = buildOpenArgv(appName, abs);
    if (!argv) {
      resolveP({ ok: false, err: `unsupported platform: ${process.platform}` });
      return;
    }
    const [cmd, ...args] = argv;
    if (!cmd) {
      resolveP({ ok: false, err: 'no open command' });
      return;
    }
    const c = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    let resolved = false;
    c.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      resolveP(code === 0 ? { ok: true } : { ok: false, err: `open exited ${code}` });
    });
    c.on('error', (e) => {
      if (resolved) return;
      resolved = true;
      resolveP({ ok: false, err: e.message });
    });
  });
}

/** Open an http(s) URL in the system default browser. */
export function openUrl(url: string): Promise<{ ok: boolean; err?: string }> {
  if (!/^https?:\/\//i.test(url)) {
    return Promise.resolve({ ok: false, err: 'not an http(s) url' });
  }
  const argv = IS_MAC
    ? ['open', url]
    : IS_WINDOWS
      ? ['cmd', '/c', 'start', '""', url]
      : ['xdg-open', url];
  const [cmd, ...args] = argv as [string, ...string[]];
  return new Promise((resolveP) => {
    const c = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    let resolved = false;
    c.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      resolveP(code === 0 ? { ok: true } : { ok: false, err: `open exited ${code}` });
    });
    c.on('error', (e) => {
      if (resolved) return;
      resolved = true;
      resolveP({ ok: false, err: e.message });
    });
  });
}

/** Reveal (select) a path in the OS file manager.
 *   • macOS:   `open -R <path>` selects it in Finder.
 *   • Windows: `explorer /select,<path>`.
 *   • Linux:   no portable "select" — xdg-open the containing directory. */
export function revealPath(path: string): Promise<{ ok: boolean; err?: string }> {
  const abs = resolveOpenPath(path);
  if (!existsSync(abs)) {
    return Promise.resolve({ ok: false, err: `no such path: ${abs}` });
  }
  const argv = IS_MAC
    ? ['open', '-R', abs]
    : IS_WINDOWS
      ? ['explorer', `/select,${abs}`]
      : IS_LINUX
        ? ['xdg-open', join(abs, '..')]
        : undefined;
  const [cmd, ...args] = argv ?? [];
  if (!cmd) {
    return Promise.resolve({ ok: false, err: `unsupported platform: ${process.platform}` });
  }
  return new Promise((resolveP) => {
    const c = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    let resolved = false;
    c.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      // explorer /select exits 1 even on success — only trust the code elsewhere
      resolveP(
        code === 0 || IS_WINDOWS ? { ok: true } : { ok: false, err: `reveal exited ${code}` },
      );
    });
    c.on('error', (e) => {
      if (resolved) return;
      resolved = true;
      resolveP({ ok: false, err: e.message });
    });
  });
}

function buildOpenArgv(appName: string, abs: string): string[] | undefined {
  // empty appName → the OS default handler for that file type (used for
  // preview-unsupported files: a .pdf opens in Preview, a .zip in Archive…).
  const sys = !appName?.trim();
  if (IS_MAC) return sys ? ['open', abs] : ['open', '-a', appName, abs];
  if (IS_WINDOWS) {
    // start: first quoted "" is the window title arg, then (app, then) file
    return sys ? ['cmd', '/c', 'start', '""', abs] : ['cmd', '/c', 'start', '""', appName, abs];
  }
  if (IS_LINUX) {
    if (!sys && (isAbsolute(appName) || whichSync(appName))) {
      return [appName, abs];
    }
    return ['xdg-open', abs];
  }
  return undefined;
}
