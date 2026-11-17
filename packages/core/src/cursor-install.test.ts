import { describe, expect, it, vi } from 'vitest';
import { cursorInstallShellScript, installCursorCli } from './cursor-install';

describe('Cursor CLI installer', () => {
  it('returns already_installed without invoking the installer', async () => {
    const runInstall = vi.fn();
    const result = await installCursorCli({
      resolveBin: () => '/home/test/.local/bin/cursor-agent',
      readVersion: async () => '2026.10.14-941492e',
      runInstall,
      path: () => '/usr/bin',
    });
    expect(result).toEqual({
      status: 'already_installed',
      path: '/home/test/.local/bin/cursor-agent',
      version: '2026.10.14-941492e',
    });
    expect(runInstall).not.toHaveBeenCalled();
  });

  it('runs the fixed script and verifies the newly detected executable/version', async () => {
    let detected = false;
    const runInstall = vi.fn(async (script: string, timeout: number, path: string) => {
      expect(script).toBe(cursorInstallShellScript());
      expect(timeout).toBeLessThanOrEqual(180_000);
      expect(path).toBe('/merged/bin:/usr/bin');
      detected = true;
      return 'Installed cursor-agent';
    });
    const result = await installCursorCli({
      resolveBin: () => (detected ? '/home/test/.local/bin/cursor-agent' : undefined),
      readVersion: async () => '2026.10.14-941492e',
      runInstall,
      path: () => '/merged/bin:/usr/bin',
    });
    expect(runInstall).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'installed',
      path: '/home/test/.local/bin/cursor-agent',
      version: '2026.10.14-941492e',
      output: 'Installed cursor-agent',
    });
  });

  it('returns an execution handle when the audited installer is still running', async () => {
    const result = await installCursorCli({
      resolveBin: () => undefined,
      runInstall: async () => ({ status: 'running', executionId: 'exec-1', output: 'starting' }),
      path: () => '/usr/bin',
    });
    expect(result).toEqual({ status: 'running', executionId: 'exec-1', output: 'starting' });
  });

  it.each([
    ['curl failure', Object.assign(new Error('curl failed'), { stderr: 'password=Secret123' })],
    ['bash failure', new Error('bash returned non-zero')],
    ['timeout', Object.assign(new Error('execution timed out'), { code: 'ETIMEDOUT' })],
  ])('returns a masked failure for %s', async (_label, failure) => {
    const result = await installCursorCli({
      resolveBin: () => undefined,
      runInstall: async () => {
        throw failure;
      },
      path: () => '/usr/bin',
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).not.toContain('Secret123');
      expect(result.output).not.toContain('Secret123');
      expect(result.error).toBeTruthy();
    }
  });

  it('rejects native Windows clearly without running the installer', async () => {
    const runInstall = vi.fn();
    const result = await installCursorCli({ platform: 'win32', runInstall });
    expect(result).toMatchObject({
      status: 'unsupported',
      error: expect.stringMatching(/not supported on native Windows/i),
    });
    expect(runInstall).not.toHaveBeenCalled();
  });

  it('fails explicitly if installation does not produce a verifiable CLI', async () => {
    const result = await installCursorCli({
      resolveBin: () => undefined,
      runInstall: async () => 'installer completed',
      path: () => '/usr/bin',
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('was not found afterward'),
    });
  });

  it('uses only the fixed official HTTPS installer URL and no caller input', () => {
    const script = cursorInstallShellScript();
    expect(script).toContain('https://cursor.com/install');
    expect(script).toContain("--proto '=https' --proto-redir '=https'");
    expect(script).toContain('mktemp');
    expect(script).toContain('trap \'rm -f "$tmp"\' EXIT');
    expect(script).toContain('bash "$tmp"');
    expect(cursorInstallShellScript()).toBe(script);
  });
});
