import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExternalExec, type LinkedExternalRun } from './external-exec';

const homes: string[] = [];

const makeHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'ateam-external-exec-'));
  mkdirSync(join(home, 'external-mcp'), { recursive: true });
  homes.push(home);
  return home;
};

const command = (script: string) => [process.execPath, '-e', script];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('ExternalExec linked runs', () => {
  it('keeps fixed internal command details out of the audited result label', async () => {
    const home = makeHome();
    const exec = new ExternalExec(home);
    const result = await exec.start({
      clientId: 'client-1',
      root: tmpdir(),
      tool: 'install_cursor_cli',
      argv: [process.execPath, '-e', "process.stdout.write('ok')"],
      displayCommand: 'Install Cursor CLI from official source',
      timeoutMs: 2_000,
    });

    expect(result.status).toBe('exited');
    expect(result.output).toBe('ok');
    expect(result.command).toBe('Install Cursor CLI from official source');
    expect(exec.get('client-1', result.execution_id).command).toBe('Install Cursor CLI from official source');
    const audit = readFileSync(join(home, 'external-mcp', 'audit.log'), 'utf8');
    expect(audit).toContain('Install Cursor CLI from official source');
    expect(audit).not.toContain('process.stdout.write');
  });

  it('keeps unlinked command results and emits no linked updates', async () => {
    const updates: LinkedExternalRun[] = [];
    const exec = new ExternalExec(makeHome(), (run) => updates.push(run));
    const result = await exec.start({
      clientId: 'client-1',
      root: tmpdir(),
      tool: 'run_command',
      argv: command("process.stdout.write('hello')"),
      timeoutMs: 2_000,
    });

    expect(result.status).toBe('exited');
    expect(result.output).toBe('hello');
    expect(exec.listLinked('stable-1', 'runtime-1')).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('publishes a running snapshot, batches output and persists masked runs by stable session', async () => {
    const home = makeHome();
    const updates: { run: LinkedExternalRun; at: number }[] = [];
    const exec = new ExternalExec(home, (run) => updates.push({ run, at: Date.now() }));
    const secret = 'sk-abcdefghijklmnopqrstuv';
    const script = `
      process.stdout.write('password=SecretValue123 token=${secret}\\n');
      let i = 0;
      const timer = setInterval(() => {
        process.stdout.write('chunk-' + i++ + '\\n');
        if (i === 14) clearInterval(timer);
      }, 50);
    `;
    const result = await exec.start({
      clientId: 'client-1',
      root: tmpdir(),
      tool: 'git_commit',
      argv: command(script),
      timeoutMs: 3_000,
      link: { sessionId: 'runtime-old', stableSessionId: 'stable-1' },
    });
    await exec.wait(result.execution_id);

    expect(updates[0]?.run).toMatchObject({
      executionId: result.execution_id,
      sessionId: 'runtime-old',
      tool: 'git_commit',
      status: 'running',
      exitCode: null,
    });
    expect(updates.at(-1)?.run.status).toBe('exited');
    expect(updates.length).toBeLessThanOrEqual(5);
    expect(updates.some(({ run }) => run.output.includes('chunk-0'))).toBe(true);
    expect(updates.at(-1)?.run.output).toContain('chunk-13');
    expect(updates.at(-1)?.run.command).not.toContain(secret);
    expect(updates.at(-1)?.run.output).not.toContain(secret);
    expect(updates.at(-1)?.run.output).toContain('password=[redacted]');

    const historyPath = join(home, 'external-mcp', 'linked-runs.json');
    const persisted = readFileSync(historyPath, 'utf8');
    expect(statSync(historyPath).mode & 0o777).toBe(0o600);
    expect(persisted).not.toContain(secret);
    expect(JSON.parse(persisted)[0]).not.toHaveProperty('sessionId');
    const restored = new ExternalExec(home);
    expect(restored.listLinked('stable-1', 'runtime-restored')).toEqual([
      expect.objectContaining({ executionId: result.execution_id, sessionId: 'runtime-restored', status: 'exited' }),
    ]);
    expect(restored.listLinked('stable-other', 'runtime-other')).toEqual([]);
  });

  it('keeps only the last 32 KB tail and marks it truncated', async () => {
    const exec = new ExternalExec(makeHome());
    const result = await exec.start({
      clientId: 'client-1',
      root: tmpdir(),
      tool: 'run_command',
      argv: command("process.stdout.write('z'.repeat(300 * 1024)); process.stdout.write('END')"),
      timeoutMs: 2_000,
      link: { sessionId: 'runtime-1', stableSessionId: 'stable-1' },
    });
    await exec.wait(result.execution_id);
    const [linked] = exec.listLinked('stable-1', 'runtime-1');

    expect(linked?.truncated).toBe(true);
    expect(Buffer.byteLength(linked?.output ?? '', 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(linked?.output).toMatch(/z+END$/);
  });

  it('publishes terminal timeout and cancellation states', async () => {
    const updates: LinkedExternalRun[] = [];
    const exec = new ExternalExec(makeHome(), (run) => updates.push(run));
    const timeout = await exec.start({
      clientId: 'client-1',
      root: tmpdir(),
      tool: 'run_command',
      argv: command('setInterval(() => {}, 1000)'),
      timeoutMs: 50,
      link: { sessionId: 'runtime-1', stableSessionId: 'stable-1' },
    });
    await exec.wait(timeout.execution_id);
    expect(updates.at(-1)).toMatchObject({ status: 'timed_out', endedAt: expect.any(String) });

    const starting = exec.start({
      clientId: 'client-1',
      root: tmpdir(),
      tool: 'run_command',
      argv: command('setInterval(() => {}, 1000)'),
      timeoutMs: 3_000,
      link: { sessionId: 'runtime-1', stableSessionId: 'stable-1' },
    });
    const running = updates.at(-1);
    expect(running?.status).toBe('running');
    const cancelled = exec.cancel('client-1', running?.executionId ?? '');
    expect(cancelled.status).toBe('cancelled');
    const result = await starting;
    await exec.wait(result.execution_id);
    expect(updates.at(-1)).toMatchObject({ status: 'cancelled', endedAt: expect.any(String) });
  });

  it('publishes a failed-to-start result', async () => {
    const updates: LinkedExternalRun[] = [];
    const exec = new ExternalExec(makeHome(), (run) => updates.push(run));
    const result = await exec.start({
      clientId: 'client-1',
      root: tmpdir(),
      tool: 'run_command',
      argv: ['/missing/ateam-external-exec-test-binary'],
      timeoutMs: 2_000,
      link: { sessionId: 'runtime-1', stableSessionId: 'stable-1' },
    });
    await exec.wait(result.execution_id);

    expect(result.status).toBe('failed_to_start');
    expect(updates.at(-1)).toMatchObject({ status: 'failed_to_start', endedAt: expect.any(String) });
  });

  it('keeps get-command-result pagination unchanged', async () => {
    const exec = new ExternalExec(makeHome());
    const result = await exec.start({
      clientId: 'client-1',
      root: tmpdir(),
      tool: 'run_command',
      argv: command("process.stdout.write('p'.repeat(40 * 1024))"),
      timeoutMs: 2_000,
    });
    const first = exec.get('client-1', result.execution_id);
    const second = exec.get('client-1', result.execution_id, first.next_cursor ?? 0);

    expect(first.output).toHaveLength(32 * 1024);
    expect(first.next_cursor).toBe(32 * 1024);
    expect(second.output).toHaveLength(8 * 1024);
    expect(second.next_cursor).toBeNull();
    expect(() => exec.get('other-client', result.execution_id)).toThrow('execution_not_found');
  });
});
