import type { ProviderId } from '@ateam/contract';
import type { Rpc } from './rpc';
import { parsePicker } from './tuiPicker';

export async function openPermissions(rpc: Pick<Rpc, 'request'>, sessionId: string): Promise<void> {
  const { projects } = await rpc.request('session.list', {});
  const session = projects
    .flatMap((project) => project.sessions)
    .find((candidate) => candidate.sessionId === sessionId);
  if (!session || session.providerId !== 'codex') {
    throw new Error('Permissions picker is only available for live Codex sessions');
  }
  await rpc.request('session.input', { sessionId, data: '/permissions' });
  await rpc.request('session.input', { sessionId, data: '\r' });
}

export function screenHasPermissionMenu(rows: readonly string[], providerId: ProviderId): boolean {
  const picker = parsePicker(rows);
  if (!picker) return false;
  if (providerId === 'codex') {
    return (
      picker.title === 'Update Model Permissions' ||
      picker.title === 'Enable full access?' ||
      picker.options.some((option) =>
        /^Yes, (?:proceed|just this once|and |allow)/i.test(option.label),
      )
    );
  }
  return (
    picker.options.some((option) => /^Yes\b/i.test(option.label)) &&
    picker.options.some((option) => /^No\b/i.test(option.label))
  );
}
