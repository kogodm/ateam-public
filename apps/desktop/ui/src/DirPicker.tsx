import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Drawer } from './Drawer';

/**
 * Workspace-directory picker. The trigger shows the current choice
 * (folder name + parent path); activating it opens a right-side drawer
 * with a search box and a roomy, scrollable list. Same value contract as
 * the original native <select>: `value` is the chosen dir ('' = no
 * directory) and `onChange` receives the dir string.
 */

export interface DirOption {
  dir: string;
  source: string;
}

interface DirPickerProps {
  value: string;
  recent: DirOption[];
  onChange: (dir: string) => void;
  /** Optional "Browse…" action (native folder picker). Omit to hide it. */
  onBrowse?: () => void;
  /** Label + meaning for the empty ('') choice, shown as the first row. */
  noneLabel: string;
}

const baseName = (d: string): string => d.split('/').filter(Boolean).pop() ?? d;
const parentPath = (d: string): string => {
  const parts = d.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? '/' + parts.join('/') : '/';
};

type Item = { kind: 'none' } | { kind: 'dir'; dir: string; source: string };

const FolderIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
  </svg>
);

export function DirPicker({ value, recent, onChange, onBrowse, noneLabel }: DirPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const customDir = value && !recent.some((d) => d.dir === value) ? value : '';

  const items: Item[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s: string) => s.toLowerCase().includes(q);
    const out: Item[] = [];
    if (!q || match(noneLabel) || match('no directory')) out.push({ kind: 'none' });
    if (customDir && (!q || match(customDir))) out.push({ kind: 'dir', dir: customDir, source: 'chosen' });
    for (const d of recent) {
      if (!q || match(d.dir) || match(d.source)) out.push({ kind: 'dir', dir: d.dir, source: d.source });
    }
    return out;
  }, [query, recent, customDir, noneLabel]);

  useEffect(() => {
    setHi((h) => Math.min(Math.max(0, h), Math.max(0, items.length - 1)));
  }, [items.length]);

  useLayoutEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const pick = (it: Item) => {
    onChange(it.kind === 'none' ? '' : it.dir);
    close();
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((h) => Math.min(items.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[hi];
      if (it) pick(it);
    }
  };

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const el = list.querySelector<HTMLElement>(`[data-i="${hi}"]`);
    if (!el) return;
    const top = el.offsetTop;
    const bot = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top - 6;
    else if (bot > list.scrollTop + list.clientHeight) list.scrollTop = bot - list.clientHeight + 6;
  }, [hi, open]);

  return (
    <div className="dirpick">
      <button
        type="button"
        className={'dirpick-trigger' + (value ? '' : ' is-none')}
        onClick={() => setOpen(true)}
        title={value || noneLabel}
      >
        <span className="dirpick-val">
          {value ? (
            <>
              <span className="dirpick-name">{baseName(value)}</span>
              <span className="dirpick-path">{parentPath(value)}</span>
            </>
          ) : (
            <span className="dirpick-name dirpick-none-text">{noneLabel}</span>
          )}
        </span>
        <span className="dirpick-caret" aria-hidden>
          ⌄
        </span>
      </button>

      <Drawer
        open={open}
        title="Workspace directory"
        subtitle="Search recent folders, or browse for a new one."
        onClose={close}
        listRef={listRef}
        search={{
          value: query,
          placeholder: 'Filter directories…',
          onChange: (v) => {
            setQuery(v);
            setHi(0);
          },
          onKeyDown: onInputKey,
          inputRef,
        }}
        footer={
          onBrowse && (
            <button
              type="button"
              className="drawer-browse"
              onClick={() => {
                close();
                onBrowse();
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
              Browse for a folder…
            </button>
          )
        }
      >
        {items.length === 0 && <div className="drawer-empty">No matching directories</div>}
        {items.map((it, i) =>
          it.kind === 'none' ? (
            <button
              key="__none__"
              type="button"
              data-i={i}
              className={'drawer-opt drawer-opt-none' + (i === hi ? ' is-hi' : '') + (!value ? ' is-sel' : '')}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(it)}
            >
              <span className="drawer-opt-icon" aria-hidden>
                ◇
              </span>
              <span className="drawer-opt-main">
                <span className="drawer-opt-name">{noneLabel}</span>
              </span>
              {!value && (
                <span className="drawer-check" aria-hidden>
                  ✓
                </span>
              )}
            </button>
          ) : (
            <button
              key={it.dir}
              type="button"
              data-i={i}
              className={'drawer-opt' + (i === hi ? ' is-hi' : '') + (value === it.dir ? ' is-sel' : '')}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(it)}
              title={it.dir}
            >
              <span className="drawer-opt-icon" aria-hidden>
                {FolderIcon}
              </span>
              <span className="drawer-opt-main">
                <span className="drawer-opt-name">{baseName(it.dir)}</span>
                <span className="drawer-opt-path">{parentPath(it.dir)}</span>
              </span>
              <span className="drawer-opt-src">{it.source}</span>
              {value === it.dir && (
                <span className="drawer-check" aria-hidden>
                  ✓
                </span>
              )}
            </button>
          ),
        )}
      </Drawer>
    </div>
  );
}
