import type { Result } from '@ateam/contract';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CrumbMenu } from './CrumbMenu';
import { DiffLines } from './DiffLines';
import { ImageView } from './ImageView';
import { PathContextMenu, usePathMenu } from './PathContextMenu';
import { resolveDocLink } from './docLink';
import { FileIcon } from './fileIcons';
import { loadScrollPosition, saveScrollPosition } from './fileScrollPosition';
import { HtmlPreview } from './HtmlPreview';
import { imageObjectUrl } from './imageBlob';
import { marked } from './markdown';
import type { Rpc } from './rpc';

type DirList = Result<'dir.list'>;
type FileRead = Result<'file.read'>;

const MD_EXT = /\.(md|markdown|mdx)$/i;
const HTML_EXT = /\.(html?|xhtml)$/i;
const CSV_EXT = /\.(csv|tsv)$/i;
/** Files that are appended to rather than edited — opened following the tail,
 *  the way `tail -f` does. A log is read from the end; starting at the top of
 *  a 3000-line run and scrolling every time is the wrong default. */
const LOG_EXT = /\.(log|out|err)(\.\d+)?$/i;
/** rows rendered in the pretty CSV table before we cut off (perf guard) */
const CSV_ROW_CAP = 1000;

/** Minimal RFC-4180-ish parser: quoted fields, escaped quotes, embedded
 *  delimiters/newlines. Enough for real-world csv/tsv previews. */
function parseDsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * In-app file browser + previewer/editor. Left: preview (image / rendered
 * markdown / editable text). Right: a filterable directory listing with a
 * breadcrumb. Supported files open here; unsupported ones bubble up via
 * `onOpenUnsupported` (OS default). The header "Open externally" button
 * always uses the system default handler too — not the OpenWith IDE.
 */
export function FileView({
  rpc,
  dir,
  file,
  openToken,
  gotoLine,
  width,
  onOpenExternal,
  onOpenUnsupported,
  onClose,
}: {
  rpc: Rpc;
  dir: string;
  file?: string;
  /** bumped by App on every open request; a dependency so reopening a file
   *  whose path is unchanged (closed, then clicked again) re-selects it */
  openToken?: number;
  /** 1-based line a terminal link asked for (`app.ts:42`) — scrolled to and
   *  selected once the content is up */
  gotoLine?: number;
  /** fixed inner width, owned by App's slide wrapper */
  width: number;
  onOpenExternal: (path: string) => void;
  /** open a file the viewer can't preview — with the OS system default, not
   *  the configured OpenWith app */
  onOpenUnsupported?: (path: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [curDir, setCurDir] = useState(dir);
  const [listing, setListing] = useState<DirList | null>(null);
  const [filter, setFilter] = useState('');
  const [tabs, setTabs] = useState<string[]>(file ? [file] : []);
  const [sel, setSel] = useState<string | undefined>(file);
  const [data, setData] = useState<FileRead | null>(null);
  // An image is handed to <img> as a blob, never as a data: URL — a multi-MB
  // data URL decodes into colour streaks in the desktop WebView. Rebuilt
  // whenever the bytes change, and revoked so they do not pile up.
  const [imgUrl, setImgUrl] = useState('');
  useEffect(() => {
    if (data?.kind !== 'image' || !data.base64) {
      setImgUrl('');
      return;
    }
    const url = imageObjectUrl(data.base64, data.mime);
    setImgUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [data]);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(false); // md: raw-edit vs rendered
  const [pixelated, setPixelated] = useState(false); // image: smooth by default
  // image zoom/pan — scale is a multiplier on the fit size; pan is a pixel
  // offset applied via transform. Reset whenever the open image changes.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const imgWrapRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('');
  // Following the end of the file. On for a log the moment it is opened;
  // scrolling away from the bottom turns it off, scrolling back turns it on,
  // so it never fights a reader who went looking for something earlier.
  const [tail, setTail] = useState(false);
  const tailRef = useRef(false);
  useEffect(() => {
    tailRef.current = tail;
  }, [tail]);
  // unsaved edits per tab so switching tabs never loses a draft
  const drafts = useRef(new Map<string, string>());
  const selName = sel?.split('/').pop() ?? '';
  const isMd = !!sel && MD_EXT.test(sel);
  const isHtml = !!sel && HTML_EXT.test(sel);
  const isCsv = !!sel && CSV_EXT.test(sel);
  const isLog = !!sel && LOG_EXT.test(sel);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm per file
  useEffect(() => {
    setTail(isLog);
  }, [sel]);

  // --- image zoom / pan ---
  // Zoom about a focal point (the cursor for the wheel; the stage centre for
  // the buttons). The image is laid out centred in the stage and shifted by
  // `pan`, so its centre sits at stageCentre + pan. To keep the point under
  // the cursor fixed while scaling by k, the new pan is d·(1−k) + k·pan, where
  // d is the cursor's offset from the stage centre. `zoomRef` mirrors `zoom`
  // and is updated synchronously so rapid wheel ticks compound correctly.
  const zoomRef = useRef(1);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  const zoomAtPoint = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const z = zoomRef.current;
    const nz = Math.min(12, Math.max(0.1, z * factor));
    if (nz === z) return;
    const k = nz / z;
    zoomRef.current = nz;
    setZoom(nz);
    if (nz <= 1) {
      setPan({ x: 0, y: 0 }); // fits the stage → centred, nothing to pan
      return;
    }
    const el = imgWrapRef.current;
    if (el && clientX !== undefined && clientY !== undefined) {
      const r = el.getBoundingClientRect();
      const dx = clientX - (r.left + r.width / 2);
      const dy = clientY - (r.top + r.height / 2);
      setPan((pp) => ({ x: dx * (1 - k) + k * pp.x, y: dy * (1 - k) + k * pp.y }));
    } else {
      setPan((pp) => ({ x: k * pp.x, y: k * pp.y })); // no focal point → toward centre
    }
  }, []);
  const resetView = useCallback(() => {
    zoomRef.current = 1;
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);
  // reset the view whenever a different file is selected
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on selection change
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [sel]);
  // wheel-to-zoom. React's onWheel can be passive (can't preventDefault), so
  // bind natively with { passive: false } while an image is shown.
  useEffect(() => {
    const el = imgWrapRef.current;
    if (!el || data?.kind !== 'image') return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      zoomAtPoint(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [data?.kind, zoomAtPoint]);
  // drag-to-pan (reads the live pan via a functional setState so the closure
  // needs no pan dependency)
  const onPanStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let base = { x: 0, y: 0 };
    setPan((p) => {
      base = p;
      return p;
    });
    const move = (ev: MouseEvent): void => {
      setPan({ x: base.x + (ev.clientX - startX), y: base.y + (ev.clientY - startY) });
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, []);
  const onImgDouble = useCallback(() => {
    setPan({ x: 0, y: 0 });
    setZoom((z) => (z === 1 ? 2 : 1));
  }, []);

  // width is owned by App's slide wrapper (fixed inner width keeps the
  // content from reflowing while the wrapper animates open/closed)
  const rootRef = useRef<HTMLDivElement>(null);

  // openTab lives further down (it needs stashDraft) — the ref lets
  // loadDir's ENOTDIR fallback reach it without widening its deps.
  const openTabRef = useRef<(path: string) => void>(() => {});

  const loadDir = useCallback(
    (d: string) => {
      void rpc
        .request('dir.list', { path: d })
        .then((r) => {
          setListing(r);
          setCurDir(r.path);
          setStatus(''); // a stale "list failed" must not outlive its cause
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          // Extensionless FILES (LICENSE, Makefile, Dockerfile) get guessed
          // as directories upstream — recover by opening the parent dir and
          // the path itself as a file tab.
          if (msg.includes('ENOTDIR')) {
            const clean = d.replace(/\/+$/, '');
            const parent = clean.slice(0, clean.lastIndexOf('/')) || '/';
            void rpc
              .request('dir.list', { path: parent })
              .then((r) => {
                setListing(r);
                setCurDir(r.path);
              })
              .catch(() => {});
            openTabRef.current(clean);
            return;
          }
          setStatus(`list failed: ${msg}`);
        });
    },
    [rpc],
  );

  useEffect(() => {
    loadDir(dir);
  }, [dir, loadDir]);

  // a new `file` prop (or the same one opened again) joins the tab strip and
  // becomes the selection. openToken is in the deps so reopening a file that
  // was closed re-selects it even though its path did not change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: openToken forces a re-open of the same path
  useEffect(() => {
    if (!file) return;
    setTabs((t) => (t.includes(file) ? t : [...t, file]));
    setSel(file);
  }, [file, openToken]);

  // Callback prop mirrored into a ref so the read effect CANNOT depend on
  // its identity: App re-renders on a 400ms ticker, and an unstable prop
  // here used to re-run the read every tick — resetting `draft` to the
  // on-disk text and eating whatever the user was typing.
  const onOpenExternalRef = useRef(onOpenExternal);
  useEffect(() => {
    onOpenExternalRef.current = onOpenExternal;
  });
  const onOpenUnsupportedRef = useRef(onOpenUnsupported);
  useEffect(() => {
    onOpenUnsupportedRef.current = onOpenUnsupported;
  });
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // Live-follow the disk via the backend's fs.watch (FSEvents push, no
  // polling): watch the dir that contains what we're showing. On change:
  //   • a file is open and there's NO local draft → re-read and swap in
  //     outside edits (claude writing the file you're looking at). A dirty
  //     draft is never clobbered — saving wins, then following resumes.
  //   • browsing a directory → refresh the listing.
  // Watch failure (exotic platform) falls back to a slow 15s poll.
  useEffect(() => {
    let live = true;
    const watchDir = sel ? sel.slice(0, sel.lastIndexOf('/')) || '/' : curDir;
    if (!watchDir) return;
    const refresh = (): void => {
      if (sel) {
        if (dirtyRef.current) return;
        void rpc
          .request('file.read', { path: sel })
          .then((r) => {
            const cur = dataRef.current;
            // Drop a read that lost the race: the effect was superseded (`live`)
            // or the result is for a DIFFERENT file than what's on screen now.
            // Without the path guard, a slow read of the previously-open file
            // (claude is editing files → fs.changed storm) could resolve late
            // and overwrite the current preview with that closed file — images
            // happened to be spared only because the kind guards didn't match.
            if (!live || !cur || r.path !== sel || cur.path !== r.path) return;
            if (r.kind === 'unsupported') return;
            if (r.kind === 'text' && cur.kind === 'text' && r.text !== cur.text) {
              setData(r);
              setDraft(r.text ?? '');
            } else if (r.kind === 'image' && cur.kind === 'image' && r.base64 !== cur.base64) {
              setData(r);
            }
          })
          .catch(() => {});
      } else {
        loadDir(curDir);
      }
    };
    let fallback: ReturnType<typeof setInterval> | undefined;
    // While following a log, poll on top of the watcher. Appends do not always
    // reach FSEvents promptly (and a coalesced burst can be seconds late),
    // which reads as a stalled `tail -f`. Only while `tail` is on and a file
    // is open, so an idle file view still costs nothing.
    const tailPoll = tail && sel ? setInterval(refresh, 1500) : undefined;
    let watching = false;
    void rpc
      .request('fs.watch', { dir: watchDir })
      .then((r) => {
        watching = r.ok;
        if (!r.ok) fallback = setInterval(refresh, 15_000);
      })
      .catch(() => {
        fallback = setInterval(refresh, 15_000);
      });
    const off = rpc.on('fs.changed', (d) => {
      if (d.dir === watchDir) refresh();
    });
    return () => {
      live = false;
      off();
      if (fallback) clearInterval(fallback);
      if (tailPoll) clearInterval(tailPoll);
      if (watching) void rpc.request('fs.unwatch', { dir: watchDir }).catch(() => {});
    };
  }, [sel, curDir, rpc, loadDir, tail]);

  // read the selected file (re-runs ONLY when the selection changes)
  useEffect(() => {
    if (!sel) {
      setData(null);
      return;
    }
    let live = true;
    void rpc
      .request('file.read', { path: sel })
      .then((r) => {
        if (!live) return;
        if (r.kind === 'unsupported') {
          (onOpenUnsupportedRef.current ?? onOpenExternalRef.current)(r.path);
          setTabs((t) => t.filter((p) => p !== r.path));
          setSel(undefined);
          return;
        }
        const pending = drafts.current.get(r.path);
        setData(r);
        setDraft(pending ?? r.text ?? '');
        setDirty(pending !== undefined);
        setEditing(pending !== undefined);
        setStatus(''); // clear a leftover read/list failure once something loads
      })
      .catch(
        (e) => live && setStatus(`read failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    return () => {
      live = false;
    };
  }, [sel, rpc]);

  // Recent-changes diff: if the open file has uncommitted changes, fetch
  // the same unified diff the git panel's popup would show (workspace.diff
  // — a plain path works whether or not `dir` is the repo root; git
  // resolves absolute pathspecs fine). `-C` targets the file's OWN
  // containing dir so this doesn't depend on FileView's current `curDir`.
  // Refetches whenever `data` changes (a fresh read, or a save landing).
  const [fileDiff, setFileDiff] = useState<{ diff: string; truncated: boolean } | null>(null);
  const [viewDiff, setViewDiff] = useState(false);
  // Which `sel` we've already auto-opened the diff for, so a LIVE refetch
  // (fs.watch picking up an outside edit while this same file stays open)
  // doesn't keep re-forcing diff view back open after the user explicitly
  // switched to plain content — auto-open is a one-time-per-file nudge,
  // not a standing override of the user's choice.
  const autoDiffSelRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    setFileDiff(null);
    if (!sel || !data || data.kind !== 'text') return;
    let live = true;
    const fileDir = sel.slice(0, sel.lastIndexOf('/')) || '/';
    void rpc
      .request('workspace.diff', { dir: fileDir, path: sel })
      .then((r) => {
        if (!live) return;
        setFileDiff(r);
        // a link that named a line wants the content at that line, so don't
        // let the one-time auto-diff nudge hijack the view out from under it
        if (r.diff.trim() && autoDiffSelRef.current !== sel && !gotoLineRef.current) {
          autoDiffSelRef.current = sel;
          setViewDiff(true);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sel, data, rpc]);
  const hasDiff = !!fileDiff?.diff.trim();
  const showingDiff = hasDiff && viewDiff && !editing;

  // Remember each file's scroll position (fileScrollPosition.ts, persisted
  // in localStorage) so reopening it — even after an app restart — resumes
  // near where you left off. One ref covers whichever content element is
  // currently mounted (.fv-md / .fv-csv / .fv-editor are mutually exclusive
  // in the JSX below); a callback ref is used (not an object ref) so it can
  // attach to either a div or a textarea without a type mismatch.
  const scrollElRef = useRef<HTMLElement | null>(null);
  const setScrollRef = useCallback((el: HTMLElement | null) => {
    scrollElRef.current = el;
  }, []);
  const suppressScrollSaveRef = useRef(false);
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout>>();
  // Restore once content is actually rendered — restoring against a stale/
  // empty DOM would set scrollTop before scrollHeight reflects the new file.
  useEffect(() => {
    if (!sel || !data) return;
    if (gotoLine) return; // an explicit line wins over "where I left off"
    if (tailRef.current) return; // following the tail wins over both
    const top = loadScrollPosition(sel);
    if (top <= 0) return;
    suppressScrollSaveRef.current = true;
    // a frame so the browser lays out the just-swapped content first
    requestAnimationFrame(() => {
      const el = scrollElRef.current;
      if (el) el.scrollTop = top;
      requestAnimationFrame(() => {
        suppressScrollSaveRef.current = false;
      });
    });
  }, [sel, data]);
  // Jump to the line a terminal link named (`src/app.ts:42`). Runs after the
  // content is mounted and beats the saved-scroll restore above — an explicit
  // "take me to line 42" outranks "put me back where I was". Selecting the
  // line rather than just scrolling is what makes it findable on screen.
  const gotoLineRef = useRef<number | undefined>(gotoLine);
  useEffect(() => {
    gotoLineRef.current = gotoLine;
  }, [gotoLine]);
  useEffect(() => {
    if (!gotoLine || !sel || !data || data.kind !== 'text') return;
    const text = data.text ?? '';
    let start = 0;
    for (let i = 1; i < gotoLine; i++) {
      const nl = text.indexOf('\n', start);
      if (nl < 0) break;
      start = nl + 1;
    }
    const nl = text.indexOf('\n', start);
    const end = nl < 0 ? text.length : nl;
    suppressScrollSaveRef.current = true;
    requestAnimationFrame(() => {
      const el = scrollElRef.current;
      if (el instanceof HTMLTextAreaElement) {
        el.focus({ preventScroll: true });
        el.setSelectionRange(start, end);
        const lh = Number.parseFloat(getComputedStyle(el).lineHeight) || 18;
        // put the target a few lines below the top edge, not flush against it
        el.scrollTop = Math.max(0, (gotoLine - 4) * lh);
      }
      requestAnimationFrame(() => {
        suppressScrollSaveRef.current = false;
      });
    });
  }, [gotoLine, sel, data]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow new content
  useEffect(() => {
    if (!tail || !data) return;
    // a frame so the just-swapped content is laid out and scrollHeight is real
    const id = requestAnimationFrame(() => {
      const el = scrollElRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [tail, data]);

  const onContentScroll = useCallback(
    (e: React.UIEvent<HTMLElement>) => {
      if (!sel || suppressScrollSaveRef.current) return;
      const el = e.currentTarget;
      const top = el.scrollTop;
      // at the bottom = following; anywhere else = the reader took over
      const atEnd = el.scrollHeight - top - el.clientHeight < 24;
      if (atEnd !== tailRef.current) setTail(atEnd);
      clearTimeout(scrollSaveTimer.current);
      scrollSaveTimer.current = setTimeout(() => saveScrollPosition(sel, top), 200);
    },
    [sel],
  );

  // Every link in the rendered markdown is handled here. Its <a> tags are
  // plain DOM (marked output), and a click left alone navigates the WEBVIEW
  // itself — a relative `nc_shard.md` replaced the whole app, the boot splash
  // came up and the app reloaded. Web links go to the system browser, file
  // links open as a tab (or the folder in the list), anchors scroll.
  const onMdClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const a = (e.target as HTMLElement).closest('a');
      if (!a) return;
      e.preventDefault();
      const link = resolveDocLink(sel ?? '/', a.getAttribute('href') ?? '');
      if (link.kind === 'external') void rpc.request('url.open', { url: link.url }).catch(() => {});
      else if (link.kind === 'file') openTabRef.current(link.path);
      else if (link.kind === 'dir') loadDir(link.path);
      else if (link.kind === 'anchor') {
        const root = e.currentTarget;
        const target =
          root.querySelector(`[id="${CSS.escape(link.id)}"]`) ??
          [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(
            (h) => h.textContent?.trim().toLowerCase().replace(/\s+/g, '-') === link.id.toLowerCase(),
          );
        target?.scrollIntoView({ block: 'start' });
      }
    },
    [rpc, sel, loadDir],
  );

  // stash the active tab's unsaved edit before the selection moves elsewhere
  const stashDraft = useCallback(() => {
    if (sel && dirty) drafts.current.set(sel, draft);
  }, [sel, dirty, draft]);

  const openTab = useCallback(
    (path: string): void => {
      stashDraft();
      setTabs((t) => (t.includes(path) ? t : [...t, path]));
      setSel(path);
    },
    [stashDraft],
  );
  useEffect(() => {
    openTabRef.current = openTab;
  });

  const closeTab = useCallback(
    (path: string): void => {
      drafts.current.delete(path);
      const i = tabs.indexOf(path);
      const next = tabs.filter((p) => p !== path);
      setTabs(next);
      if (path === sel) {
        setSel(next.length ? next[Math.min(i, next.length - 1)] : undefined);
        if (!next.length) setData(null);
      }
    },
    [tabs, sel],
  );

  const openEntry = (e: DirList['entries'][number]): void => {
    if (e.dir) loadDir(e.path);
    else openTab(e.path);
  };
  const { menu, openMenu, closeMenu } = usePathMenu();

  const save = useCallback(() => {
    if (!sel) return;
    // no "saving…/saved" chatter — the tab's dirty dot clearing IS the
    // success signal; only failures speak up.
    void rpc
      .request('file.write', { path: sel, text: draft })
      .then((r) => {
        if (r.ok) {
          setDirty(false);
          setStatus(''); // clear a stale "save failed" from an earlier try
          drafts.current.delete(sel);
          setData((d) => (d ? { ...d, text: draft } : d));
        } else {
          setStatus(`save failed: ${r.err ?? 'unknown'}`);
        }
      })
      .catch((e) => setStatus(`save failed: ${e instanceof Error ? e.message : String(e)}`));
  }, [rpc, sel, draft]);

  // Cmd/Ctrl+S saves, Esc closes — but ONLY when the key lands inside the
  // files panel. The conversation stays live next to us; a vim user hitting
  // Esc in the terminal must not close this panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && dirty) {
        e.preventDefault();
        save();
      }
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, save, onClose]);

  const mdHtml = useMemo(() => {
    if (!isMd || !data?.text) return '';
    try {
      return marked.parse(editing ? draft : data.text, { async: false }) as string;
    } catch {
      return '';
    }
  }, [isMd, data, editing, draft]);

  const csvRows = useMemo(() => {
    if (!isCsv || !sel) return null;
    const text = draft || data?.text || '';
    if (!text) return null;
    return parseDsv(text, sel.toLowerCase().endsWith('.tsv') ? '\t' : ',');
  }, [isCsv, sel, draft, data]);

  // the breadcrumb follows the SELECTED file's real location (a tab may live
  // in a different directory than the one currently listed); no file → the
  // listed directory
  const crumbDir = sel ? sel.slice(0, sel.lastIndexOf('/')) || '/' : curDir;
  const crumbs = crumbDir.split('/').filter(Boolean);
  const entries = (listing?.entries ?? []).filter((e) =>
    filter ? e.name.toLowerCase().includes(filter.toLowerCase()) : true,
  );

  return (
    <div ref={rootRef} className="fileview" style={{ width }}>
      <header className="fv-head">
        <button type="button" className="fv-close" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
        <nav className="fv-crumbs">
          <CrumbMenu
            rpc={rpc}
            dir="/"
            label="/"
            current={crumbs[0]}
            onDir={loadDir}
            onFile={(f) => {
              loadDir(f.slice(0, f.lastIndexOf('/')) || '/');
              openTab(f);
            }}
            onContextMenu={(ev) => openMenu(ev, '/', true)}
          />
          {crumbs.map((c, i) => {
            const p = `/${crumbs.slice(0, i + 1).join('/')}`;
            return (
              <span key={p} className="fv-crumb-item">
                <span className="fv-crumb-sep">›</span>
                {/* clicking a segment drops down THAT directory's contents;
                    "Open this folder" is the first row */}
                <CrumbMenu
                  rpc={rpc}
                  dir={p}
                  label={c}
                  current={i + 1 < crumbs.length ? crumbs[i + 1] : selName || undefined}
                  onDir={loadDir}
                  onFile={(f) => {
                    loadDir(f.slice(0, f.lastIndexOf('/')) || '/');
                    openTab(f);
                  }}
                  onContextMenu={(ev) => openMenu(ev, p, true)}
                />
              </span>
            );
          })}
          {selName && sel && (
            <>
              <span className="fv-crumb-sep">›</span>
              <span className="fv-crumb-file" onContextMenu={(ev) => openMenu(ev, sel, false)}>
                {selName}
              </span>
            </>
          )}
        </nav>
        {sel && (
          <button
            type="button"
            className="fv-external"
            onClick={() => onOpenExternal(sel)}
            title="Open with the system default app"
          >
            Open externally
          </button>
        )}
      </header>

      {tabs.length > 0 && (
        <div className="fv-tabs">
          {tabs.map((p) => {
            const name = p.split('/').pop() ?? p;
            const tabDirty = p === sel ? dirty : drafts.current.has(p);
            return (
              <div key={p} className={`fv-tab${p === sel ? ' is-active' : ''}`} title={p}>
                <button type="button" className="fv-tab-name" onClick={() => openTab(p)}>
                  {tabDirty && <span className="fv-tab-dot" />}
                  {name}
                </button>
                <button
                  type="button"
                  className="fv-tab-close"
                  onClick={() => closeTab(p)}
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="fv-body">
        <section className="fv-preview">
          {/* no file selected = directory browse: render the listing in the
              preview area itself. Once a file is open the whole panel is
              preview/editor — the Panel's Files tree is the picker, a
              permanent second listing column here would duplicate it. */}
          {!sel && (
            <div className="fv-dir">
              <input
                className="fv-filter"
                placeholder="Filter files…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <div className="fv-entries">
                {listing?.parent && (
                  <button
                    type="button"
                    className="fv-entry"
                    onClick={() => loadDir(listing.parent as string)}
                  >
                    <span className="fv-ico">↰</span>
                    <span className="fv-name">..</span>
                  </button>
                )}
                {entries.map((e) => (
                  <button
                    type="button"
                    key={e.path}
                    className={`fv-entry${e.dir ? ' is-dir' : ''}`}
                    onClick={() => openEntry(e)}
                    onContextMenu={(ev) => openMenu(ev, e.path, e.dir)}
                    title={e.name}
                  >
                    <span className="fv-ico">
                      <FileIcon name={e.name} dir={e.dir} />
                    </span>
                    <span className="fv-name">{e.name}</span>
                    {!e.dir && <span className="fv-size">{fmtSize(e.size)}</span>}
                    {e.dir && <span className="fv-chev">›</span>}
                  </button>
                ))}
                {entries.length === 0 && <div className="fv-empty small">no matching files</div>}
              </div>
            </div>
          )}
          {sel && data?.kind === 'image' && (
            <div className="fv-text-wrap">
              <div className="fv-text-bar">
                <span className="fv-fname">{selName}</span>
                <span className="fv-spacer" />
                <button
                  type="button"
                  className="fv-toggle"
                  onClick={() => zoomAtPoint(1 / 1.2)}
                  title="Zoom out"
                >
                  －
                </button>
                <button
                  type="button"
                  className="fv-zoom"
                  onClick={resetView}
                  title="Reset to fit (double-click image toggles 1×/2×)"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  className="fv-toggle"
                  onClick={() => zoomAtPoint(1.2)}
                  title="Zoom in"
                >
                  ＋
                </button>
                <button
                  type="button"
                  className="fv-toggle"
                  onClick={() => setPixelated((v) => !v)}
                  title="Toggle between smooth scaling and crisp pixels"
                >
                  {pixelated ? 'Smooth' : 'Pixelated'}
                </button>
              </div>
              <ImageView
                src={imgUrl}
                mime={data.mime ?? ''}
                size={data.size}
                mtime={data.mtime}
                name={selName}
                zoom={zoom}
                pan={pan}
                pixelated={pixelated}
                wrapRef={imgWrapRef}
                onPanStart={onPanStart}
                onDouble={onImgDouble}
              />
            </div>
          )}
          {sel && data?.kind === 'text' && (
            <div className="fv-text-wrap">
              <div className="fv-text-bar">
                <span className="fv-fname">{selName}</span>
                <span className="fv-spacer" />
                {data.truncated && (
                  <span className="fv-warn">
                    {data.fromEnd ? 'showing the last 2 MB' : 'truncated'}
                  </span>
                )}
                {hasDiff && !editing && (
                  <button
                    type="button"
                    className={`fv-toggle${showingDiff ? ' is-active' : ''}`}
                    onClick={() => setViewDiff((v) => !v)}
                    title="This file has uncommitted changes vs HEAD"
                  >
                    {showingDiff ? 'Content' : 'Diff'}
                  </button>
                )}
                {!editing && !showingDiff && (
                  <button
                    type="button"
                    className={`fv-toggle${tail ? ' is-active' : ''}`}
                    onClick={() => {
                      const next = !tail;
                      setTail(next);
                      if (next) {
                        const el = scrollElRef.current;
                        if (el) el.scrollTop = el.scrollHeight;
                      }
                    }}
                    title={
                      tail
                        ? 'Following new lines — scroll up to stop'
                        : 'Follow the end of the file as it grows'
                    }
                  >
                    Tail
                  </button>
                )}
                {(isMd || isHtml || isCsv) && (
                  <button
                    type="button"
                    className="fv-toggle"
                    onClick={() => {
                      setViewDiff(false); // editing always shows the live editable content
                      setEditing((v) => !v);
                    }}
                  >
                    {editing ? 'Preview' : 'Edit'}
                  </button>
                )}
                {dirty && (
                  <button type="button" className="fv-save" onClick={save}>
                    Save
                  </button>
                )}
                <span className="fv-status">{status}</span>
              </div>
              {showingDiff ? (
                <div
                  className="fv-diff diff-body mono"
                  ref={setScrollRef}
                  onScroll={onContentScroll}
                >
                  <DiffLines diff={fileDiff?.diff ?? ''} />
                </div>
              ) : isMd && !editing ? (
                // biome-ignore lint/a11y/useKeyWithClickEvents: delegates to <a> clicks only, not a general interactive container
                <div
                  className="fv-md"
                  ref={setScrollRef}
                  onScroll={onContentScroll}
                  onClick={onMdClick}
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: local file, rendered md
                  dangerouslySetInnerHTML={{ __html: mdHtml }}
                />
              ) : isCsv && !editing && csvRows ? (
                <div className="fv-csv" ref={setScrollRef} onScroll={onContentScroll}>
                  <table>
                    <thead>
                      <tr>
                        {(csvRows[0] ?? []).map((h, ci) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: static parse, never reordered
                          <th key={ci}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {csvRows.slice(1, 1 + CSV_ROW_CAP).map((r, ri) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: static parse, never reordered
                        <tr key={ri}>
                          {r.map((cell, ci) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: static parse, never reordered
                            <td key={ci} title={cell.length > 60 ? cell : undefined}>
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {csvRows.length - 1 > CSV_ROW_CAP && (
                    <div className="muted small fv-csv-more">
                      showing first {CSV_ROW_CAP.toLocaleString()} of{' '}
                      {(csvRows.length - 1).toLocaleString()} rows — Edit to see the raw file
                    </div>
                  )}
                </div>
              ) : isHtml && !editing ? (
                <HtmlPreview rpc={rpc} path={sel ?? ''} title={selName} html={draft || data.text || ''} />
              ) : (
                <textarea
                  className="fv-editor"
                  ref={setScrollRef}
                  onScroll={onContentScroll}
                  value={draft}
                  spellCheck={false}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setDirty(true);
                  }}
                />
              )}
            </div>
          )}
        </section>
      </div>
      {menu && (
        <PathContextMenu
          rpc={rpc}
          menu={menu}
          onClose={closeMenu}
          onOpen={(abs, dir) => {
            if (dir) loadDir(abs);
            else openTab(abs);
          }}
          onNote={setStatus}
        />
      )}
    </div>
  );
}
