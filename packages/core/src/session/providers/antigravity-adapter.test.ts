import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  antigravityAdapter,
  requireAgyBin,
  resolveAgyBin,
} from './antigravity-adapter';
import { getAdapter } from './index';
import type { ProviderBuildArgs } from './provider-adapter';

const roots: string[] = [];

function executable(dir: string, name = 'agy'): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const base: ProviderBuildArgs = {
  sessionId: 'ateam-session',
  sessionName: 'ignored',
  cwd: '/project',
  appendSystemPrompt: 'do not inject me',
  settingsJson: '{"ignored":true}',
  mcpConfigPath: '/tmp/mcp.json',
};

describe('Antigravity CLI provider adapter', () => {
  it('is registered as the antigravity provider', () => {
    expect(getAdapter('antigravity')).toBe(antigravityAdapter);
  });

  it('resolves agy from PATH and ~/.local/bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-agy-path-'));
    roots.push(root);
    const bin = executable(join(root, 'bin'));
    expect(resolveAgyBin({ path: join(root, 'bin'), home: root, loginPath: '' })).toBe(bin);

    const homeRoot = mkdtempSync(join(tmpdir(), 'ateam-agy-home-'));
    roots.push(homeRoot);
    const homeBin = executable(join(homeRoot, '.local', 'bin'));
    expect(resolveAgyBin({ path: '', home: homeRoot, loginPath: '' })).toBe(homeBin);
  });

  it('also searches the login-shell PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-agy-login-'));
    roots.push(root);
    const bin = executable(join(root, 'login-bin'));
    expect(
      resolveAgyBin({
        path: '',
        home: join(root, 'empty-home'),
        loginPath: join(root, 'login-bin'),
      }),
    ).toBe(bin);
  });

  it('requireAgyBin throws a useful error when missing', () => {
    expect(() => requireAgyBin(() => undefined)).toThrow(/Antigravity CLI not found/);
  });

  it('starts a fresh session with no invented flags', () => {
    expect(antigravityAdapter.buildArgs(base)).toEqual([]);
  });

  it('resumes with --conversation <id>', () => {
    expect(antigravityAdapter.buildArgs({ ...base, resumeSessionId: 'conv-1' })).toEqual([
      '--conversation',
      'conv-1',
    ]);
  });

  it('passes --model when bound', () => {
    expect(antigravityAdapter.buildArgs({ ...base, model: 'gemini-4-hydrogen' })).toEqual([
      '--model',
      'gemini-4-hydrogen',
    ]);
  });

  it('passes initial prompt via --prompt-interactive (not -p)', () => {
    expect(antigravityAdapter.buildArgs({ ...base, initialPrompt: 'continue the handoff' })).toEqual(
      ['--prompt-interactive', 'continue the handoff'],
    );
  });

  it('combines resume + model + initial prompt; ignores recall/MCP/settings', () => {
    expect(
      antigravityAdapter.buildArgs({
        ...base,
        resumeSessionId: 'conv-9',
        model: 'gemini-3.8-flash',
        initialPrompt: 'hi',
      }),
    ).toEqual([
      '--conversation',
      'conv-9',
      '--model',
      'gemini-3.8-flash',
      '--prompt-interactive',
      'hi',
    ]);
  });
});
