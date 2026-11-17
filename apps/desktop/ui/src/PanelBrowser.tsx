import { useEffect, useState } from 'react';
import type { Rpc } from './rpc';

interface Shot {
  base64: string;
  url: string;
  title: string;
  at: number;
}

/**
 * The session's own browser, live. Claude drives a headless Chrome through the
 * `ateam-browser` MCP; this paints that tab in the side panel. It only asks for
 * a picture (never starts a browser) and polls while the tab is open.
 */
export function BrowserPane({ rpc, sessionId }: { rpc: Rpc; sessionId: string }): JSX.Element {
  const [shot, setShot] = useState<Shot | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let stop = false;
    setShot(null);
    setAsked(false);
    const pull = (): void => {
      rpc
        .request('browser.shot', { sessionId, width: 960 })
        .then((r) => {
          if (stop) return;
          setShot(r ?? null);
          setAsked(true);
        })
        .catch(() => undefined);
    };
    pull();
    const timer = setInterval(pull, 1500);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [rpc, sessionId]);

  if (!shot)
    return (
      <div className="muted">
        {asked ? "This session hasn't opened a page yet." : 'Looking for the session browser...'}
      </div>
    );
  return (
    <div className="panel-browser">
      <div className="panel-browser-head">
        <span className="panel-browser-title">{shot.title || 'Browser'}</span>
        <span className="panel-browser-url">{shot.url}</span>
      </div>
      <img
        className="panel-browser-shot"
        alt={shot.title || shot.url}
        src={`data:image/jpeg;base64,${shot.base64}`}
      />
    </div>
  );
}
