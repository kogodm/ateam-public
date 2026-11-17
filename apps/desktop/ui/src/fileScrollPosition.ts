/**
 * Per-file scroll position for FileView's preview/editor, persisted in
 * localStorage (survives app restarts) so reopening a file resumes near
 * where you left off. Keyed by absolute path — paths are already globally
 * unique, no project scoping needed. Capped + LRU-evicted (object key
 * insertion order) so a long-lived install doesn't grow this forever.
 */
const KEY = 'ateam.fileview.scroll';
const MAX_ENTRIES = 300;

type ScrollMap = Record<string, number>;

function load(): ScrollMap {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ScrollMap) : {};
  } catch {
    return {};
  }
}

export function loadScrollPosition(path: string): number {
  return load()[path] ?? 0;
}

export function saveScrollPosition(path: string, top: number): void {
  try {
    const map = load();
    delete map[path]; // re-insert at the end so key order tracks recency
    map[path] = top;
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
    }
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* private mode */
  }
}
