import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IS_WINDOWS, whichSync, whichViaSystem } from '../platform';

/** Where a `codex` binary may live when it is NOT on PATH: the ChatGPT /
 *  Codex desktop apps bundle the CLI inside their .app (verified:
 *  ChatGPT.app/Contents/Resources/codex is a plain Mach-O `codex-cli`), so a
 *  user who only installed the app still has a working runtime. */
export function codexBinCandidates(): string[] {
  if (IS_WINDOWS) {
    const lad = process.env.LOCALAPPDATA;
    return lad
      ? [
          join(lad, 'Programs', 'ChatGPT', 'resources', 'codex.exe'),
          join(lad, 'Programs', 'Codex', 'resources', 'codex.exe'),
        ]
      : [];
  }
  const apps = ['/Applications', join(homedir(), 'Applications')];
  const out: string[] = [];
  for (const dir of apps) {
    for (const app of ['ChatGPT.app', 'Codex.app']) {
      out.push(
        join(
          dir,
          app,
          'Contents',
          'Resources',
          'codex-cli',
          'CodexCLI.app',
          'Contents',
          'MacOS',
          'codex',
        ),
      );
      out.push(join(dir, app, 'Contents', 'Resources', 'codex'));
      out.push(join(dir, app, 'Contents', 'MacOS', 'codex'));
    }
  }
  return out;
}

function binaryVersion(path: string): number[] | undefined {
  try {
    const result = spawnSync(path, ['--version'], {
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 4096,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return undefined;
    const version = result.stdout
      .trim()
      .match(/^(?:codex(?:-cli)?\s+)?(\d+)\.(\d+)\.(\d+)(?:\s|$|-)/);
    return version ? version.slice(1).map(Number) : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCodexBin(): string | undefined {
  if (process.env.ATEAM_CODEX_BIN) return process.env.ATEAM_CODEX_BIN;
  const candidates = [
    ...new Set(
      [
        ...codexBinCandidates().filter((candidate) => existsSync(candidate)),
        whichSync('codex'),
        whichViaSystem('codex'),
      ].filter((candidate): candidate is string => !!candidate),
    ),
  ];
  let selected = candidates[0];
  let highest: number[] | undefined;
  for (const candidate of candidates) {
    const version = binaryVersion(candidate);
    if (!version) continue;
    const difference = highest
      ? version.map((part, index) => part - (highest![index] ?? 0)).find((part) => part !== 0)
      : 1;
    if (difference !== undefined && difference > 0) {
      selected = candidate;
      highest = version;
    }
  }
  return selected;
}
