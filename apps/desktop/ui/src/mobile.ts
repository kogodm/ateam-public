import { useEffect, useState } from 'react';

/** Phone-class viewport: narrow, or a coarse pointer on a smallish screen.
 *  `?mobile=1` forces it (dev). The desktop layout stays the same; App only
 *  collapses the side panes by default, turns them into drawers, and shows
 *  the touch key bar. */
const MQ = '(max-width: 820px), ((pointer: coarse) and (max-width: 1100px))';

export function useIsMobile(): boolean {
  const [m, setM] = useState<boolean>(() => {
    try {
      if (new URLSearchParams(window.location.search).get('mobile') === '1') return true;
      return window.matchMedia(MQ).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const q = window.matchMedia(MQ);
    const on = (): void =>
      setM(q.matches || new URLSearchParams(window.location.search).get('mobile') === '1');
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return m;
}

/** keys the touch bar can send — raw bytes for the PTY */
export const MOBILE_KEYS: readonly {
  label: string;
  seq: string;
  title: string;
  wide?: boolean;
  /** hold to auto-repeat (arrows, delete) */
  repeat?: boolean;
}[] = [
  { label: 'Esc', seq: '\x1b', title: 'Escape' },
  { label: '⌫', seq: '\x7f', title: 'Backspace', repeat: true },
  { label: 'Tab', seq: '\t', title: 'Tab' },
  { label: '^C', seq: '\x03', title: 'Ctrl-C (interrupt)' },
  { label: '^D', seq: '\x04', title: 'Ctrl-D' },
  { label: '↑', seq: '\x1b[A', title: 'Up', repeat: true },
  { label: '↓', seq: '\x1b[B', title: 'Down', repeat: true },
  { label: '←', seq: '\x1b[D', title: 'Left', repeat: true },
  { label: '→', seq: '\x1b[C', title: 'Right', repeat: true },
  { label: '⏎', seq: '\r', title: 'Enter', wide: true },
];

/** Register the pass-through service worker (PWA installability). Browser
 *  contexts only — the Tauri shell and non-secure origins skip it. */
export function registerPwa(): void {
  try {
    if ('isTauri' in window) return;
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  } catch {
    /* not a browser context */
  }
}
