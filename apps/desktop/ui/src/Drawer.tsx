import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Shared right-side slide-out drawer shell. Rendered through a portal to
 * <body> so it escapes any modal's overflow clipping. Handles the scrim,
 * slide-in animation, and an Escape key that closes ONLY the drawer
 * (capture phase + stopPropagation so the app's window-level Escape — which
 * closes the whole modal — does not also fire). Consumers fill the body
 * (their option list) and optionally a search box + footer.
 */

interface DrawerSearch {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}

interface DrawerProps {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  search?: DrawerSearch;
  listRef?: React.Ref<HTMLDivElement>;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function Drawer({ open, title, subtitle, onClose, search, listRef, footer, children }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="drawer-scrim" onMouseDown={onClose}>
      <aside className="drawer" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div className="drawer-head-text">
            <h4>{title}</h4>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {search && (
          <div className="drawer-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              ref={search.inputRef}
              value={search.value}
              placeholder={search.placeholder}
              onChange={(e) => search.onChange(e.target.value)}
              onKeyDown={search.onKeyDown}
            />
            {search.value && (
              <button
                type="button"
                className="drawer-clear"
                onClick={() => search.onChange('')}
                aria-label="Clear"
              >
                ✕
              </button>
            )}
          </div>
        )}

        <div className="drawer-list" ref={listRef}>
          {children}
        </div>

        {footer && <footer className="drawer-foot">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}
