import { type FSWatcher, watch } from 'node:fs';

/** Junk churn we never notify about — build output and VCS internals fire
 *  storms of events that no file view cares to re-render for. */
const IGNORE_RE =
  /(^|\/)(node_modules|\.git|\.next|\.turbo|\.codegraph|__pycache__)(\/|$)/;

interface Entry {
  watcher: FSWatcher;
  refs: number;
  pending: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Ref-counted recursive directory watchers (FSEvents on macOS, native
 * equivalents elsewhere) feeding a single debounced `fs.changed` emit per
 * dir. UI panels fs.watch/fs.unwatch the dirs they display instead of
 * polling.
 */
export class FsWatchHub {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly emitChange: (dir: string, paths: string[]) => void) {}

  /** Start (or ref) a recursive watch. False when the platform refuses —
   *  callers should fall back to slow polling. */
  watchDir(dir: string): boolean {
    const existing = this.entries.get(dir);
    if (existing) {
      existing.refs++;
      return true;
    }
    try {
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        const entry = this.entries.get(dir);
        if (!entry) return;
        const rel = filename ? String(filename) : '';
        if (rel && IGNORE_RE.test(rel)) return;
        entry.pending.add(rel);
        // debounce: builds touch dozens of files in one burst — coalesce
        // into a single notification with a capped path sample
        entry.timer ??= setTimeout(() => {
          entry.timer = undefined;
          const paths = [...entry.pending].slice(0, 50);
          entry.pending.clear();
          this.emitChange(dir, paths);
        }, 300);
      });
      watcher.on('error', () => this.drop(dir));
      this.entries.set(dir, { watcher, refs: 1, pending: new Set() });
      return true;
    } catch {
      return false;
    }
  }

  unwatchDir(dir: string): void {
    const entry = this.entries.get(dir);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) this.drop(dir);
  }

  private drop(dir: string): void {
    const entry = this.entries.get(dir);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.watcher.close();
    } catch {
      /* already closed */
    }
    this.entries.delete(dir);
  }

  shutdown(): void {
    for (const dir of [...this.entries.keys()]) this.drop(dir);
  }
}
