import type { Update } from '@tauri-apps/plugin-updater';
import { useEffect, useState } from 'react';

/**
 * "A new Ateam is out" — the desktop window only.
 *
 * The feed is the relay (`/update/latest.json`, see apps/relay/src/update-api.ts):
 * CI publishes signed bundles there, and the updater checks the signature
 * against the public key in tauri.conf.json before installing anything.
 *
 * Installing ends in a relaunch, and the sessions run inside the app — so the
 * app never restarts on its own. It asks; the person picks the moment. Their
 * sessions come back the way any restart brings them back (autoResume).
 */

/** first look shortly after launch, not during it: startup is busy enough */
const FIRST_CHECK_MS = 20_000;
const RECHECK_MS = 6 * 60 * 60 * 1000;

type State =
  | { phase: 'idle' }
  | { phase: 'ready'; update: Update }
  | { phase: 'installing'; update: Update; pct?: number }
  | { phase: 'failed'; update: Update; err: string };

function inDesktopWindow(): boolean {
  return 'isTauri' in window && Boolean((window as { isTauri?: boolean }).isTauri);
}

export function UpdateBanner(): JSX.Element | null {
  const [state, setState] = useState<State>({ phase: 'idle' });
  /** "Later" hides this version until the next launch; a newer one shows again */
  const [dismissed, setDismissed] = useState('');

  useEffect(() => {
    if (!inDesktopWindow()) return;
    let alive = true;
    const look = async (): Promise<void> => {
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        // never interrupt an install in progress with a newer find
        if (alive && update)
          setState((s) => (s.phase === 'installing' ? s : { phase: 'ready', update }));
      } catch {
        // offline, relay down, feed not published yet: try again next round
      }
    };
    const first = setTimeout(() => void look(), FIRST_CHECK_MS);
    const every = setInterval(() => void look(), RECHECK_MS);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);

  if (state.phase === 'idle') return null;
  const { update } = state;
  if (state.phase === 'ready' && dismissed === update.version) return null;

  const install = async (): Promise<void> => {
    setState({ phase: 'installing', update });
    try {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === 'Started') total = ev.data.contentLength ?? 0;
        if (ev.event === 'Progress') {
          got += ev.data.chunkLength;
          if (total > 0) setState({ phase: 'installing', update, pct: Math.round((got / total) * 100) });
        }
      });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      setState({ phase: 'failed', update, err: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="update-banner" role="status">
      {state.phase === 'installing' ? (
        <span>
          Updating to Ateam {update.version}
          {state.pct !== undefined ? ` · ${state.pct}%` : '…'}
        </span>
      ) : (
        <>
          <span>
            {state.phase === 'failed'
              ? `Update failed: ${state.err}`
              : `Ateam ${update.version} is available`}
          </span>
          <button type="button" className="primary" onClick={() => void install()}>
            {state.phase === 'failed' ? 'Try again' : 'Restart to update'}
          </button>
          <button
            type="button"
            onClick={() => {
              setDismissed(update.version);
              setState({ phase: 'ready', update });
            }}
          >
            Later
          </button>
        </>
      )}
    </div>
  );
}
