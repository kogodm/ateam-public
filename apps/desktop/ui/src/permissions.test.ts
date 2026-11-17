import { describe, expect, it, vi } from 'vitest';
import { openPermissions, screenHasPermissionMenu } from './permissions';
import confirmRows from './permissions-confirm.fixture.json';
import type { Rpc } from './rpc';

function mockRpc(providerId: string | undefined, exists = true) {
  const request = vi.fn().mockResolvedValue({});
  request.mockResolvedValueOnce({
    projects: [{ sessions: exists ? [{ sessionId: 'target', providerId }] : [] }],
  });
  return { request, rpc: { request } as unknown as Pick<Rpc, 'request'> };
}

describe('openPermissions', () => {
  it('targets the live Codex session and sends command before a separate Enter', async () => {
    const { rpc, request } = mockRpc('codex');
    await openPermissions(rpc, 'target');
    expect(request.mock.calls).toEqual([
      ['session.list', {}],
      ['session.input', { sessionId: 'target', data: '/permissions' }],
      ['session.input', { sessionId: 'target', data: '\r' }],
    ]);
  });

  it.each(['claude', 'opencode', undefined])(
    'never sends Codex commands to %s',
    async (providerId) => {
      const { rpc, request } = mockRpc(providerId);
      await expect(openPermissions(rpc, 'target')).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it('does not write to a missing session', async () => {
    const { rpc, request } = mockRpc('codex', false);
    await expect(openPermissions(rpc, 'target')).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not submit when the command write fails', async () => {
    const { rpc, request } = mockRpc('codex');
    request.mockRejectedValueOnce(new Error('disconnected'));
    await expect(openPermissions(rpc, 'target')).rejects.toThrow('disconnected');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('surfaces session lookup failures without writing input', async () => {
    const request = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(
      openPermissions({ request } as unknown as Pick<Rpc, 'request'>, 'target'),
    ).rejects.toThrow('offline');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('permission waiting indicator', () => {
  it('recognises the captured Codex full-access secondary confirmation', () => {
    expect(screenHasPermissionMenu(confirmRows, 'codex')).toBe(true);
  });

  it('recognises the permission profile picker', () => {
    expect(
      screenHasPermissionMenu(
        [
          '  Update Model Permissions',
          '› 1. Ask for approval  Read and edit workspace files',
          '  2. Approve for me    Only ask for potentially unsafe actions',
          '  3. Full Access       Use with caution',
          '  4. Read Only         Read workspace files',
          '  enter select · esc back',
        ],
        'codex',
      ),
    ).toBe(true);
  });

  it('recognises a two-option command approval without requiring option 3', () => {
    expect(
      screenHasPermissionMenu(
        [
          '  Would you like to run the following command?',
          '› 1. Yes, proceed',
          '  2. No, continue without running',
          '  Press enter to confirm or esc to go back',
        ],
        'codex',
      ),
    ).toBe(true);
  });

  it('does not flag model selection or model switch confirmation', () => {
    expect(
      screenHasPermissionMenu(
        ['  Select Model and Effort', '› 1. Sol', '  2. Terra', '  enter select · esc back'],
        'codex',
      ),
    ).toBe(false);
    expect(
      screenHasPermissionMenu(
        ['  Switch model?', '› 1. Yes, switch model', '  2. No, go back'],
        'codex',
      ),
    ).toBe(false);
  });

  it('clears on the current idle screen rather than old permission text', () => {
    expect(
      screenHasPermissionMenu(
        ['› Ask Codex to do anything', '  Plan mode (⇧tab to cycle)'],
        'codex',
      ),
    ).toBe(false);
    expect(screenHasPermissionMenu([], 'codex')).toBe(false);
  });
});

describe('Full Access confirm drawn over the middle of the screen (codex 0.162.0)', async () => {
  const screens = (await import('./fixtures/codex-0.162.0-screens.json')).default as Record<
    string,
    string[]
  >;
  it('counts as waiting on a permission', () => {
    expect(screenHasPermissionMenu(screens.fullAccessConfirm ?? [], 'codex')).toBe(true);
    expect(screenHasPermissionMenu(screens.fullAccessConfirmOverReply ?? [], 'codex')).toBe(true);
  });
});
