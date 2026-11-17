import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import { maskOutput } from './external-exec';
import { mergedPath } from './platform';
import { resolveCursorBin } from './session/providers/cursor-adapter';

const INSTALL_TIMEOUT_MS = 180_000;
const OUTPUT_LIMIT = 4_000;
const CURSOR_INSTALL_SCRIPT = `set -eu
tmp="$(mktemp "\${TMPDIR:-/tmp}/ateam-cursor-install.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --output "$tmp" https://cursor.com/install
bash "$tmp"`;

export type CursorInstallResult =
  | { status: 'already_installed'; path: string; version?: string }
  | { status: 'installed'; path: string; version: string; output: string }
  | { status: 'running'; executionId: string; output: string }
  | { status: 'unsupported' | 'failed'; error: string; output: string };

export type CursorInstallRunResult =
  | string
  | { status: 'running'; executionId: string; output?: string };

export interface CursorInstallDeps {
  platform?: NodeJS.Platform;
  resolveBin?: () => string | undefined;
  runInstall?: (script: string, timeoutMs: number, path: string) => Promise<CursorInstallRunResult>;
  readVersion?: (bin: string, path: string) => Promise<string | undefined>;
  path?: () => string;
}

/** Fixed, input-free installer command. Callers cannot supply shell fragments. */
export function cursorInstallShellScript(): string {
  return CURSOR_INSTALL_SCRIPT;
}

function outputTail(text: string): string {
  const safe = maskOutput(text.trim());
  return safe.length > OUTPUT_LIMIT ? safe.slice(-OUTPUT_LIMIT) : safe;
}

function errorDetails(error: unknown): string {
  const e = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
  const message =
    e?.code === 'ETIMEDOUT'
      ? 'Cursor CLI installation timed out.'
      : e?.message || 'Cursor CLI installation failed.';
  const details = [e?.stderr, e?.stdout].filter(Boolean).join('\n');
  return outputTail([message, details].filter(Boolean).join('\n'));
}

function runInstallScript(script: string, timeoutMs: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const options: ExecFileOptions = {
      env: { ...process.env, PATH: path },
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    };
    execFile('bash', ['-c', script], options, (error, stdout, stderr) => {
      const output = outputTail([stdout, stderr].filter(Boolean).join('\n'));
      if (error) {
        Object.assign(error, { stdout: output });
        reject(error);
      } else {
        resolve(output);
      }
    });
  });
}

function readCursorVersion(bin: string, path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ['--version'],
      {
        env: { ...process.env, PATH: path },
        timeout: 5_000,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) return resolve(undefined);
        const version = outputTail(stdout || stderr);
        resolve(version || undefined);
      },
    );
  });
}

/** Install Cursor CLI only when explicitly invoked by a user-facing action. */
export async function installCursorCli(deps: CursorInstallDeps = {}): Promise<CursorInstallResult> {
  if ((deps.platform ?? process.platform) === 'win32') {
    return {
      status: 'unsupported',
      error:
        'Automatic Cursor CLI installation is not supported on native Windows. Use WSL or install Cursor CLI manually.',
      output: '',
    };
  }

  const findBin = deps.resolveBin ?? resolveCursorBin;
  const current = findBin();
  const path = (deps.path ?? mergedPath)();
  const readVersion = (bin: string) =>
    deps.readVersion ? deps.readVersion(bin, path) : readCursorVersion(bin, path);
  if (current) {
    return { status: 'already_installed', path: current, version: await readVersion(current) };
  }

  try {
    const run = deps.runInstall ?? runInstallScript;
    const runResult = await run(cursorInstallShellScript(), INSTALL_TIMEOUT_MS, path);
    if (typeof runResult !== 'string') {
      return {
        status: 'running',
        executionId: runResult.executionId,
        output: outputTail(runResult.output ?? ''),
      };
    }
    const output = runResult;
    const installed = findBin();
    if (!installed) {
      return {
        status: 'failed',
        error:
          'The installer completed, but cursor-agent was not found afterward. Check the installer output or PATH.',
        output: outputTail(output),
      };
    }
    const version = await readVersion(installed);
    if (!version) {
      return {
        status: 'failed',
        error: 'cursor-agent was installed but its --version check failed.',
        output: outputTail(output),
      };
    }
    return { status: 'installed', path: installed, version, output: outputTail(output) };
  } catch (error) {
    return { status: 'failed', error: errorDetails(error), output: errorDetails(error) };
  }
}
