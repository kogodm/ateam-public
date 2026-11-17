import type { WorkspaceInfoDTO } from '@ateam/contract';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PathContextMenu, usePathMenu } from './PathContextMenu';
import { FileIcon } from './fileIcons';
import { loadLocations, saveLocations } from './filesLocations';
import { PATH_DRAG_MIME } from './pathInsert';
import type { Rpc } from './rpc';

const SHOW_HIDDEN_KEY = 'ateam.files.showHidden';
/** the last-selected location for this project — reopening defaults to it. */
const currentKey = (scope: string): string => `ateam.files.current:${scope}`;
/** flat tree row (mirrors WorkspaceInfoDTO['tree'][number]) */
interface Entry {
  path: string;
  depth: number;
  dir: boolean;
}
/** same junk dirs the backend tree skips — applied to lazily loaded levels */
// only true noise; dist/build/coverage are ordinary folders in many projects
const LAZY_SKIP = new Set(['node_modules', '.turbo', '.next']);
/** expanded dirs per location — folders start COLLAPSED and only the
 *  user's own clicks (persisted here) open them. */
const expandKey = (dir: string): string => `ateam.files.expanded:${dir}`;

/** Files pane: a switchable file location (session cwd + user-added dirs) with
 *  a workspace tree, per-type icons, a dotfile toggle and a right-click menu. */
export function FilesPane({
  rpc,
  dir,
  onOpenPath,
  baseLabel = 'session',
}: {
  rpc: Rpc;
  /** the focused session's cwd — the default, non-removable location */
  dir: string;
  onOpenPath?: (path: string) => void;
  /** suffix shown on the base `dir` option in the location dropdown (e.g.
   *  "session" for a session cwd, "memory" for a human's meta dir). */
  baseLabel?: string;
}): JSX.Element {
  const [ws, setWs] = useState<WorkspaceInfoDTO | null>(null);
  // The locations live on the server now (see filesLocations.ts), so they
  // arrive a tick after mount instead of being known synchronously. Start on
  // the session cwd — always valid, never removable — and restore the last
  // selection once the list is in hand.
  const [locations, setLocations] = useState<string[]>([]);
  const [current, setCurrent] = useState<string>(dir);
  useEffect(() => {
    let alive = true;
    setLocations([]);
    setCurrent(dir);
    void loadLocations(rpc, dir)
      .then((list) => {
        if (!alive) return;
        setLocations(list);
        try {
          const saved = localStorage.getItem(currentKey(dir));
          if (saved && (saved === dir || list.includes(saved))) setCurrent(saved);
        } catch {
          /* private mode */
        }
      })
      .catch(() => {
        /* keep the session cwd — the pane still works with just it */
      });
    return () => {
      alive = false;
    };
  }, [rpc, dir]);
  // default: every folder folded. The user's expand clicks are remembered
  // per location, so the tree reopens exactly how they left it.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHOW_HIDDEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const { menu, openMenu, closeMenu } = usePathMenu();
  const [note, setNote] = useState('');
  // children fetched on demand for dirs DEEPER than the base tree carries
  // (workspace.info ships ~3 levels; expanding past that lazy-loads via
  // dir.list, so any depth is reachable).
  const [extra, setExtra] = useState<Map<string, Entry[]>>(new Map());

  const extraRef = useRef(extra);
  useEffect(() => {
    extraRef.current = extra;
  }, [extra]);
  const expandedRef = useRef(expanded);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  // switching location: load that location's remembered expand set and drop
  // the previous location's lazily-grafted deep levels. Also runs on first
  // mount (current === dir), seeding the initial expand set.
  useEffect(() => {
    try {
      localStorage.setItem(currentKey(dir), current); // remember for next open
      const raw = localStorage.getItem(expandKey(current));
      setExpanded(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setExpanded(new Set());
    }
    setExtra(new Map());
    setWs(null);
  }, [current, dir]);

  // Freshness comes from the backend's recursive fs.watch (FSEvents):
  // one fs.changed event per debounced burst → refetch. Identity-preserving
  // setters keep static content from re-rendering. If the platform can't
  // watch, fall back to a slow 15s poll.
  useEffect(() => {
    const applyWs = (info: WorkspaceInfoDTO): void => {
      setWs((prev) => (prev && JSON.stringify(prev) === JSON.stringify(info) ? prev : info));
    };
    /** re-list one dir (relative to `current`) straight from disk and graft
     *  it into `extra`, which the renderer prefers over the base tree. */
    const relist = (rel: string): void => {
      const depth = rel.split('/').length;
      void rpc
        .request('dir.list', { path: `${current}/${rel}` })
        .then((r) => {
          const kids: Entry[] = r.entries
            .filter((en) => !LAZY_SKIP.has(en.name))
            .map((en) => ({ path: `${rel}/${en.name}`, depth, dir: en.dir }));
          const prev = extraRef.current.get(rel);
          if (prev && JSON.stringify(kids) === JSON.stringify(prev)) return;
          setExtra((m) => new Map(m).set(rel, kids));
        })
        .catch(() => {});
    };
    const refetch = (fresh: boolean, changed: string[] = []): void => {
      void rpc
        .request('workspace.info', { dir: current, fresh })
        .then((r) => applyWs(r.info))
        .catch(() => {});
      // the lazily-loaded deep levels currently grafted on screen
      const targets = new Set(extraRef.current.keys());
      // …plus the parent of every changed path that is currently EXPANDED
      // (#11): a folder created deep down, or under a dir whose base-tree
      // listing was cut by fileTree's entry cap, never surfaced otherwise —
      // the base tree can't carry it and nothing else re-listed that parent.
      for (const p of changed) {
        const slash = p.lastIndexOf('/');
        if (slash <= 0) continue; // top level — the base tree refetch covers it
        const parent = p.slice(0, slash);
        if (expandedRef.current.has(parent)) targets.add(parent);
      }
      for (const rel of targets) relist(rel);
    };
    refetch(false);
    let fallback: ReturnType<typeof setInterval> | undefined;
    let watching = false;
    void rpc
      .request('fs.watch', { dir: current })
      .then((r) => {
        watching = r.ok;
        if (!r.ok) fallback = setInterval(() => refetch(false), 15_000);
      })
      .catch(() => {
        fallback = setInterval(() => refetch(false), 15_000);
      });
    const off = rpc.on('fs.changed', (d) => {
      if (d.dir === current) refetch(true, d.paths);
    });
    return () => {
      off();
      if (fallback) clearInterval(fallback);
      if (watching) void rpc.request('fs.unwatch', { dir: current }).catch(() => {});
    };
  }, [rpc, current]);

  const toggleHidden = useCallback(() => {
    setShowHidden((v) => {
      try {
        localStorage.setItem(SHOW_HIDDEN_KEY, v ? '0' : '1');
      } catch {
        /* private mode */
      }
      return !v;
    });
  }, []);

  // dropdown options: session cwd first (default, non-removable), then the
  // user's added locations — de-duplicated so cwd never appears twice.
  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of [dir, ...locations]) {
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  }, [dir, locations]);

  const addLocation = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: 'Add a file location',
      });
      if (typeof picked === 'string' && picked) {
        setLocations((prev) => {
          if (prev.includes(picked) || picked === dir) return prev;
          const next = [...prev, picked];
          void saveLocations(rpc, dir, next);
          return next;
        });
        setCurrent(picked);
      }
    } catch (e) {
      setNote(`Could not pick a directory: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [dir, rpc]);

  const removeCurrent = useCallback(() => {
    if (current === dir) return; // the session cwd is never removable
    setLocations((prev) => {
      const next = prev.filter((p) => p !== current);
      void saveLocations(rpc, dir, next);
      return next;
    });
    setCurrent(dir);
  }, [current, dir, rpc]);

  // base tree (flat DFS) → parent-path → children map, so rendering can
  // recurse and graft the lazily fetched deeper levels in.
  const childrenOf = useMemo(() => {
    const m = new Map<string, Entry[]>();
    if (!ws) return m;
    for (const e of ws.tree) {
      const slash = e.path.lastIndexOf('/');
      const parent = slash === -1 ? '' : e.path.slice(0, slash);
      const arr = m.get(parent) ?? [];
      arr.push(e);
      m.set(parent, arr);
    }
    return m;
  }, [ws]);

  // Hydrate lazily-loaded children for folders that are ALREADY expanded but
  // sit deeper than the base tree — an expand set restored from localStorage on
  // remount (tab switch) or after a location change. Without this they render
  // EMPTY until collapse + re-expand, because toggleDir only fetches on the
  // opening click. Guarded by extraRef so each deep dir is fetched at most once.
  useEffect(() => {
    if (!ws) return;
    for (const path of expanded) {
      if (childrenOf.has(path) || extraRef.current.has(path)) continue;
      const depth = path.split('/').length;
      void rpc
        .request('dir.list', { path: `${current}/${path}` })
        .then((r) => {
          const kids: Entry[] = r.entries
            .filter((en) => !LAZY_SKIP.has(en.name))
            .map((en) => ({ path: `${path}/${en.name}`, depth, dir: en.dir }));
          setExtra((m) => (m.has(path) ? m : new Map(m).set(path, kids)));
        })
        .catch(() => {});
    }
  }, [ws, expanded, childrenOf, current, rpc]);

  const visibleTree = useMemo(() => {
    if (!ws) return [];
    const out: Entry[] = [];
    const emit = (parent: string): void => {
      // a fresh dir.list (lazy level or fs.changed re-list) beats the base
      // tree's snapshot, which may be stale or cut by the entry cap
      const kids = extra.get(parent) ?? childrenOf.get(parent) ?? [];
      for (const e of kids) {
        if (out.length >= 600) return;
        const name = e.path.split('/').pop() ?? '';
        if (!showHidden && name.startsWith('.')) continue;
        out.push(e);
        if (e.dir && expanded.has(e.path)) emit(e.path);
      }
    };
    emit('');
    return out;
  }, [ws, childrenOf, extra, expanded, showHidden]);

  const toggleDir = useCallback(
    (e: Entry) => {
      // Just toggle + persist. Lazy-loading children for a deep folder is
      // handled by the hydrate effect above (keyed on `expanded`), which
      // covers both this click and expand sets restored on remount.
      setExpanded((s) => {
        const n = new Set(s);
        if (n.has(e.path)) n.delete(e.path);
        else n.add(e.path);
        try {
          localStorage.setItem(expandKey(current), JSON.stringify([...n]));
        } catch {
          /* private mode */
        }
        return n;
      });
    },
    [current],
  );

  const shortLabel = (p: string): string => {
    const base = p.replace(/\/+$/, '').split('/').pop() || p;
    return p === dir ? `${base}  ·${baseLabel}` : base;
  };

  return (
    <>
      <div className="status-section">
        <div className="status-section-title">Location</div>
        <div className="files-loc">
          <select
            className="files-loc-select"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            title={current}
          >
            {options.map((p) => (
              <option key={p} value={p}>
                {shortLabel(p)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="files-loc-btn"
            onClick={() => void addLocation()}
            title="Add a file location"
          >
            ＋
          </button>
          {current !== dir && (
            <button
              type="button"
              className="files-loc-btn"
              onClick={removeCurrent}
              title="Remove this location from the list"
            >
              ✕
            </button>
          )}
          <button
            type="button"
            className="files-loc-btn"
            onClick={() => onOpenPath?.(current)}
            title="Open this directory in the default app"
          >
            ⤢
          </button>
        </div>
        <div className="files-loc-path mono muted" title={current}>
          {current}
        </div>
      </div>
      {!ws ? (
        <div className="muted small">loading…</div>
      ) : (
        <div className="status-section files-tree">
          <div className="status-section-title files-title">
            <span>Files</span>
            <button
              type="button"
              className={`files-hidden-toggle${showHidden ? ' on' : ''}`}
              onClick={toggleHidden}
              title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
            >
              .∗
            </button>
            <button
              type="button"
              className="files-browse"
              onClick={() => onOpenPath?.(ws.dir)}
              title="Browse this location in the file viewer"
            >
              Browse ⤢
            </button>
          </div>
          {visibleTree.slice(0, 400).map((e) => {
            const name = e.path.split('/').pop() ?? '';
            const abs = `${ws.dir}/${e.path}`;
            const isOpen = e.dir && expanded.has(e.path);
            return (
              <button
                key={e.path}
                type="button"
                className="rec path-link tree-row"
                style={{ paddingLeft: 6 + e.depth * 12 }}
                draggable
                onDragStart={(ev) => {
                  // drag a file/dir onto a session terminal → its path is
                  // inserted into that session's input (see Term onDrop).
                  ev.dataTransfer.setData(PATH_DRAG_MIME, abs);
                  ev.dataTransfer.setData('text/plain', abs);
                  ev.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => {
                  if (e.dir) toggleDir(e);
                  else onOpenPath?.(abs);
                }}
                onContextMenu={(ev) => openMenu(ev, abs, e.dir)}
                title={e.dir ? abs : `open · ${abs}`}
              >
                <span className="tree-twirl">{e.dir ? (isOpen ? '▾' : '▸') : ' '}</span>
                <FileIcon name={name} dir={e.dir} /> {name}
              </button>
            );
          })}
        </div>
      )}
      {note && <div className="muted small">{note}</div>}
      {menu && (
        <PathContextMenu
          rpc={rpc}
          menu={menu}
          onClose={closeMenu}
          onOpen={(abs) => onOpenPath?.(abs)}
          onNote={setNote}
        />
      )}
    </>
  );
}
