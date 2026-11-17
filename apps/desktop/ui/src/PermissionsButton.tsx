import type { ProviderId } from '@ateam/contract';
import { useEffect, useState } from 'react';
import { openPermissions } from './permissions';
import type { Rpc } from './rpc';

export function PermissionsButton({
  rpc,
  sessionId,
  providerId,
  className,
  onSent,
}: {
  rpc: Rpc | null;
  sessionId: string;
  providerId?: ProviderId;
  className: string;
  onSent?: () => void;
}): JSX.Element | null {
  const [resolved, setResolved] = useState<{ sessionId: string; providerId?: ProviderId }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setError('');
    if (rpc && sessionId && !providerId) {
      void rpc
        .request('session.list', {})
        .then(({ projects }) => {
          const session = projects
            .flatMap((project) => project.sessions)
            .find((candidate) => candidate.sessionId === sessionId);
          if (alive) setResolved({ sessionId, providerId: session?.providerId });
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [rpc, sessionId, providerId]);
  const provider =
    providerId ?? (resolved?.sessionId === sessionId ? resolved.providerId : undefined);
  if (provider !== 'codex') return null;
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={!rpc || !sessionId || busy}
        title="Open Codex permissions picker — changes require your selection"
        onClick={() => {
          if (!rpc || busy) return;
          setBusy(true);
          setError('');
          void openPermissions(rpc, sessionId)
            .then(() => onSent?.())
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setBusy(false));
        }}
      >
        Permissions
      </button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}
