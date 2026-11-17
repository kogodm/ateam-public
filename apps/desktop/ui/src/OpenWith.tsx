import type { Result } from '@ateam/contract';
import { useEffect, useRef, useState } from 'react';
import type { Rpc } from './rpc';

type AppList = Result<'app.list'>['apps'];

/**
 * Top-right "open with…" dropdown. The chosen app's name is persisted in
 * localStorage (ateam.defaultOpener). Empty means the OS default handler —
 * that is also the factory default (we do not auto-pick VS Code). File view
 * "Open externally" always uses the system opener regardless of this pick.
 */
export function OpenWith({
  rpc,
  defaultAppName,
  setDefaultAppName,
}: {
  rpc: Rpc;
  defaultAppName: string;
  setDefaultAppName: (name: string) => void;
}): JSX.Element {
  const [apps, setApps] = useState<AppList>([]);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void rpc.request('app.list', {}).then((r) => {
      setApps(r.apps);
      // Empty defaultAppName means the OS default handler — do not auto-pick
      // VS Code / Cursor; "Open externally" and unsupported files already use
      // the system opener, and forcing an IDE here surprised people.
    });
    // real installed-app icons (macOS .icns → png). Arrives late on first
    // call (one sips per app); letter badges hold the fort meanwhile.
    void rpc
      .request('app.icons', {})
      .then((r) => setIcons(r.icons))
      .catch(() => {});
  }, [rpc]);

  const badge = (id: string | undefined, label: string): JSX.Element =>
    id && icons[id] ? (
      <img className="ow-icon" src={`data:image/png;base64,${icons[id]}`} alt="" />
    ) : (
      <span className="ow-badge">{label.charAt(0).toUpperCase()}</span>
    );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = apps.find((a) => a.appName === defaultAppName);

  return (
    <div className="open-with" ref={rootRef}>
      <button
        type="button"
        className="bar-icon open-with-trigger"
        onClick={() => setOpen((v) => !v)}
        title={
          current
            ? `Open paths with ${current.label} (click to change)`
            : 'Open paths with the system default app (click to change)'
        }
      >
        {badge(current?.id, current?.label ?? 'System')}
        <span className="ow-caret">▾</span>
      </button>
      {open && (
        <div className="open-with-menu" role="menu">
          {apps.length === 0 && <div className="ow-empty muted">scanning apps…</div>}
          <button
            type="button"
            className={`ow-item ${!defaultAppName ? 'on' : ''}`}
            onClick={() => {
              setDefaultAppName('');
              setOpen(false);
            }}
            title="Use the OS default handler for each file type"
          >
            <span className="ow-badge">S</span>
            <span className="ow-name">System default</span>
          </button>
          {apps.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`ow-item ${a.appName === defaultAppName ? 'on' : ''} ${a.available ? '' : 'off'}`}
              disabled={!a.available}
              onClick={() => {
                setDefaultAppName(a.appName);
                setOpen(false);
              }}
              title={a.available ? '' : 'not installed'}
            >
              {badge(a.id, a.label)}
              <span className="ow-name">{a.label}</span>
              {!a.available && <span className="muted small">not installed</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
