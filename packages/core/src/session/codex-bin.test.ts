import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whichSync, whichViaSystem } from '../platform';
import { codexBinCandidates, resolveCodexBin } from './codex-bin';

vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('node:os', () => ({ homedir: () => '/fixture/home' }));
vi.mock('../platform', () => ({ IS_WINDOWS: false, whichSync: vi.fn(), whichViaSystem: vi.fn() }));

const bundled =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

beforeEach(() => {
  vi.stubEnv('ATEAM_CODEX_BIN', '');
  vi.mocked(existsSync).mockReturnValue(false);
  vi.mocked(whichSync).mockReturnValue('/opt/homebrew/bin/codex');
  vi.mocked(whichViaSystem).mockReturnValue(undefined);
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: 'codex-cli 0.161.0\n' } as ReturnType<
    typeof spawnSync
  >);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('Codex bundled binary selection', () => {
  it('prefers the nested desktop CLI when versions tie', () => {
    vi.mocked(existsSync).mockImplementation((path) =>
      String(path).includes('/Applications/ChatGPT.app/'),
    );
    expect(resolveCodexBin()).toBe(bundled);
    expect(whichSync).toHaveBeenCalled();
  });
  it('also discovers user-installed desktop bundles', () => {
    const path = bundled.replace('/Applications/', '/fixture/home/Applications/');
    vi.mocked(existsSync).mockImplementation((candidate) => candidate === path);
    expect(resolveCodexBin()).toBe(path);
    expect(codexBinCandidates()).toContain(path);
  });
  it('preserves an explicit override and falls back when no bundle exists', () => {
    expect(resolveCodexBin()).toBe('/opt/homebrew/bin/codex');
    vi.stubEnv('ATEAM_CODEX_BIN', '/fixture/custom/codex');
    expect(resolveCodexBin()).toBe('/fixture/custom/codex');
  });
  it.each([
    ['0.159.0', '0.161.0', '/opt/homebrew/bin/codex'],
    ['0.162.0', '0.161.0', bundled],
    ['0.9.0', '0.10.0', '/opt/homebrew/bin/codex'],
  ])('compares bundle %s and PATH %s numerically', (bundleVersion, pathVersion, expected) => {
    vi.mocked(existsSync).mockImplementation((candidate) => candidate === bundled);
    vi.mocked(spawnSync).mockImplementation(
      (path) =>
        ({
          status: 0,
          stdout: `codex-cli ${path === bundled ? bundleVersion : pathVersion}`,
        }) as ReturnType<typeof spawnSync>,
    );
    expect(resolveCodexBin()).toBe(expected);
  });
  it('ignores failed probes and bounds version checks', () => {
    vi.mocked(existsSync).mockImplementation((candidate) => candidate === bundled);
    vi.mocked(spawnSync).mockImplementation(
      (path) =>
        ({ status: path === bundled ? 1 : 0, stdout: 'codex-cli 0.161.0' }) as ReturnType<
          typeof spawnSync
        >,
    );
    expect(resolveCodexBin()).toBe('/opt/homebrew/bin/codex');
    expect(spawnSync).toHaveBeenCalledWith(
      bundled,
      ['--version'],
      expect.objectContaining({ timeout: 1000, maxBuffer: 4096 }),
    );
  });
  it('keeps a discovered fallback when all probes fail', () => {
    vi.mocked(existsSync).mockImplementation((candidate) => candidate === bundled);
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '' } as ReturnType<typeof spawnSync>);
    expect(resolveCodexBin()).toBe(bundled);
  });
});
