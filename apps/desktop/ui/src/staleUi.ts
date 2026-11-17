/**
 * "The fix isn't in the app" — when really the phone never reloaded.
 *
 * The desktop app is upgraded and relaunched all the time. A browser or PWA
 * client (phone over LAN/relay) only loses its WebSocket for a few seconds and
 * then reconnects — the document is never reloaded, so it keeps running the
 * JS it downloaded from the OLD build while talking to the NEW server. Every
 * change looks unshipped, and you debug a build nobody is running.
 *
 * The tell is cheap: vite writes content-hashed asset names, and the build
 * counter changes on every real build, so a rebuilt UI ALWAYS has a different
 * main chunk name. Compare what the server serves now against what this
 * document actually loaded.
 */

/** Module scripts index.html pulls in — the identity of the running build. */
export function scriptPathsIn(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const src = m[1];
    if (src) out.push(src.replace(/^\.?\//, ''));
  }
  return out;
}

/**
 * True when the served index.html names a script this document does not have.
 *
 * Deliberately one-directional and conservative: an EMPTY served list (a login
 * gate, a proxy error page, an offline fetch) proves nothing and must never
 * trigger a reload loop — only a script we can see and do not have does.
 */
export function servedUiIsNewer(servedHtml: string, loadedPaths: readonly string[]): boolean {
  const served = scriptPathsIn(servedHtml);
  if (served.length === 0) return false;
  const have = new Set(loadedPaths.map((p) => p.replace(/^\.?\//, '')));
  return served.some((s) => !have.has(s));
}

/** Reload the page if the server has moved on to a newer UI build. */
export async function reloadIfServerUiIsNewer(): Promise<void> {
  // The Tauri window loads the UI out of its own bundle — it cannot be stale
  // relative to the sidecar it ships with, and there is nothing to re-fetch.
  if (typeof window === 'undefined' || 'isTauri' in window) return;
  try {
    const res = await fetch('/index.html', { cache: 'no-store' });
    if (!res.ok) return; // login gate / relay hiccup — not evidence of anything
    const loaded = [...document.querySelectorAll('script[src]')].map(
      (el) => new URL((el as HTMLScriptElement).src, window.location.href).pathname,
    );
    if (servedUiIsNewer(await res.text(), loaded)) window.location.reload();
  } catch {
    /* offline — the reconnect loop is already handling it */
  }
}
