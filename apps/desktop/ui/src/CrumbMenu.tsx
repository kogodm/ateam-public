import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileIcon } from './fileIcons';
import type { Rpc } from './rpc';

interface Entry {
  name: string;
  path: string;
  dir: boolean;
}

/** A breadcrumb segment: click it to drop down THAT directory's contents
 *  and jump straight to a child dir / file (first row opens the folder
 *  itself) — lateral navigation without walking back through the listing. */
export function CrumbMenu({
  rpc,
  dir,
  label,
  current,
  onDir,
  onFile,
  onContextMenu,
}: {
  rpc: Rpc;
  /** absolute directory this segment stands for — the menu lists its children */
  dir: string;
  /** segment text */
  label: string;
  /** the child currently on the path (highlighted) */
  current?: string;
  onDir: (path: string) => void;
  onFile: (path: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  // the crumb strip clips overflow and the file view slides in with a
  // transform (which turns position:fixed into "relative to that ancestor"),
  // so the popover is PORTALED to <body> at the button's screen rect
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setEntries(null);
    void rpc
      .request('dir.list', { path: dir })
      .then((r) => {
        if (live) setEntries(r.entries.map((e) => ({ name: e.name, path: e.path, dir: e.dir })));
      })
      .catch(() => {
        if (live) setEntries([]);
      });
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      live = false;
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, rpc, dir]);

  return (
    <span ref={rootRef} className={`fv-crumb-seg${open ? ' open' : ''}`}>
      <button
        ref={btnRef}
        type="button"
        className="fv-crumb-seg-btn"
        onClick={() => {
          const r = btnRef.current?.getBoundingClientRect();
          if (r) setAt({ top: r.bottom + 4, left: r.left });
          setOpen((o) => !o);
        }}
        onContextMenu={onContextMenu}
        title={`Browse ${dir}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {label}
      </button>
      {open &&
        at &&
        createPortal(
          <div
            ref={menuRef}
            className="dd-menu fv-crumb-menu"
            style={{ position: 'fixed', top: at.top, left: at.left, zIndex: 1000 }}
          >
            <button
              type="button"
              className="dd-option fv-crumb-open"
              onClick={() => {
                setOpen(false);
                onDir(dir);
              }}
            >
              <span className="fv-crumb-menu-ico">
                <FileIcon name={label} dir />
              </span>
              <span className="dd-option-label">Open this folder</span>
            </button>
            {entries === null && <div className="dd-option muted">…</div>}
            {entries?.length === 0 && <div className="dd-option muted">(empty)</div>}
            {entries?.map((e) => (
              <button
                type="button"
                key={e.path}
                className={`dd-option${e.name === current ? ' on' : ''}`}
                onClick={() => {
                  setOpen(false);
                  if (e.dir) onDir(e.path);
                  else onFile(e.path);
                }}
              >
                <span className="fv-crumb-menu-ico">
                  <FileIcon name={e.name} dir={e.dir} />
                </span>
                <span className="dd-option-label">{e.name}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}
