import { useCallback, useState } from 'react';
import type { Rpc } from './rpc';

/** Clipboard write that works both inside Tauri (plugin) and in a plain
 *  browser (navigator) — same routing Term.tsx uses for copy-on-select. */
function copyText(text: string): void {
  if ('isTauri' in window) {
    void import('@tauri-apps/plugin-clipboard-manager')
      .then((m) => m.writeText(text))
      .catch(() => {});
  } else if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {});
  }
}

export interface PathMenuState {
  x: number;
  y: number;
  abs: string;
  dir: boolean;
}

/** Right-click state + an onContextMenu factory, shared by every file list. */
export function usePathMenu(): {
  menu: PathMenuState | null;
  openMenu: (ev: React.MouseEvent, abs: string, dir: boolean) => void;
  closeMenu: () => void;
} {
  const [menu, setMenu] = useState<PathMenuState | null>(null);
  const openMenu = useCallback((ev: React.MouseEvent, abs: string, dir: boolean) => {
    ev.preventDefault();
    ev.stopPropagation();
    setMenu({
      x: Math.min(ev.clientX, window.innerWidth - 200),
      y: Math.min(ev.clientY, window.innerHeight - 130),
      abs,
      dir,
    });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  return { menu, openMenu, closeMenu };
}

/** The Open / Reveal in Finder / Copy Path popup for one path. */
export function PathContextMenu({
  rpc,
  menu,
  onClose,
  onOpen,
  onNote,
}: {
  rpc: Rpc;
  menu: PathMenuState;
  onClose: () => void;
  /** invoked with the path when the user picks Open */
  onOpen: (abs: string, dir: boolean) => void;
  /** surface a short status line ('path copied', errors) */
  onNote?: (s: string) => void;
}): JSX.Element {
  const reveal = useCallback(() => {
    void rpc
      .request('path.reveal', { path: menu.abs })
      .then((r) => {
        if (!r.ok) onNote?.(`reveal failed: ${r.err ?? 'unknown'}`);
      })
      .catch((e) =>
        onNote?.(`reveal failed: ${e instanceof Error ? e.message : String(e)}`),
      );
  }, [rpc, menu.abs, onNote]);

  return (
    <div
      className="ctx-overlay"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
        <button
          type="button"
          onClick={() => {
            onOpen(menu.abs, menu.dir);
            onClose();
          }}
        >
          Open
        </button>
        <button
          type="button"
          onClick={() => {
            reveal();
            onClose();
          }}
        >
          Reveal in Finder
        </button>
        <button
          type="button"
          onClick={() => {
            copyText(menu.abs);
            onNote?.('path copied');
            onClose();
          }}
        >
          Copy Path
        </button>
      </div>
    </div>
  );
}
