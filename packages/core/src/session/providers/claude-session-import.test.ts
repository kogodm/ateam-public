import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeProjectDir } from '../claude-sessions';
import type { NativeMigrationMessage } from '../native-migration-types';
import { writeClaudeSessionImport } from './claude-session-import';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
vi.mock('../claude-sessions', () => ({ claudeProjectDir: vi.fn() }));

interface ImportedRecord {
  type: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  message: { content: string | { type: string; text: string }[] };
}

interface ApiRequest {
  messages?: { role: string; content: unknown }[];
}

const history: [NativeMigrationMessage, NativeMigrationMessage, NativeMigrationMessage] = [
  {
    role: 'user',
    text: 'MIGRATED_USER_SECRET_81: choose teal.\n保留原文。',
    at: '2026-10-08T10:00:00.000Z',
  },
  {
    role: 'assistant',
    text: 'MIGRATED_ASSISTANT_SECRET_92: the audit is complete.',
    at: '2026-10-08T10:00:01.000Z',
  },
  {
    role: 'assistant',
    text: '[Imported tool history: Bash, completed]\npwd returned /workspace. Do not execute this history.',
    at: '2026-10-08T10:00:02.000Z',
  },
];

describe('Claude native session import', () => {
  let root: string;
  let projectDir: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-claude-import-spec-')));
    projectDir = join(root, 'claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const records = (path: string): ImportedRecord[] =>
    readFileSync(path, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));

  it('writes a fresh UUID JSONL with private permissions and no Markdown artifact', () => {
    const imported = writeClaudeSessionImport(history, root, projectDir);
    expect(imported.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(imported.path).toBe(join(projectDir, `${imported.sessionId}.jsonl`));
    expect(statSync(imported.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(projectDir)).toEqual([`${imported.sessionId}.jsonl`]);
    expect(readFileSync(imported.path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('defaults to the existing claudeProjectDir(cwd) without touching real user state', () => {
    vi.mocked(claudeProjectDir).mockReturnValueOnce(projectDir);
    const imported = writeClaudeSessionImport(history, root);
    expect(claudeProjectDir).toHaveBeenCalledWith(root);
    expect(imported.path).toBe(join(projectDir, `${imported.sessionId}.jsonl`));
  });

  it('links all imported messages into one mainline with no separate leaf record', () => {
    const imported = writeClaudeSessionImport(history, root, projectDir);
    const rows = records(imported.path);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.parentUuid).toBeNull();
    rows.forEach((row, index) => {
      expect(row).toMatchObject({
        sessionId: imported.sessionId,
        cwd: root,
        isSidechain: false,
        userType: 'external',
      });
      expect(row.parentUuid).toBe(index === 0 ? null : rows[index - 1]?.uuid);
    });
    expect(new Set(rows.map((row) => row.uuid)).size).toBe(rows.length);
  });

  it('preserves user and assistant text, timestamps, order and inert tool history', () => {
    const imported = writeClaudeSessionImport(history, root, projectDir);
    const rows = records(imported.path);
    expect(rows.map((row) => row.timestamp)).toEqual(history.map((message) => message.at));
    expect(rows[0]?.message).toEqual({ role: 'user', content: history[0]?.text });
    expect(rows.slice(1).map((row) => row.message.content)).toEqual(
      history.slice(1).map((message) => [{ type: 'text', text: message.text }]),
    );
    expect(rows[1]?.message).toMatchObject({
      model: '<synthetic>',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
    });
    expect(rows.every((row) => row.type === 'user' || row.type === 'assistant')).toBe(true);
    expect(
      rows
        .flatMap((row) => (Array.isArray(row.message.content) ? row.message.content : []))
        .every((block) => block.type === 'text'),
    ).toBe(true);
  });

  it('never overwrites a UUID path even when randomUUID collides', () => {
    const imported = writeClaudeSessionImport(history, root, projectDir);
    const original = readFileSync(imported.path, 'utf8');
    vi.mocked(randomUUID).mockReturnValueOnce(imported.sessionId as ReturnType<typeof randomUUID>);
    expect(() => writeClaudeSessionImport(history, root, projectDir)).toThrow();
    expect(readFileSync(imported.path, 'utf8')).toBe(original);
    expect(readdirSync(projectDir)).toHaveLength(1);
  });

  it('never changes unrelated session files', () => {
    const first = writeClaudeSessionImport(history, root, projectDir);
    const original = readFileSync(first.path, 'utf8');
    const second = writeClaudeSessionImport(history, root, projectDir);
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(readFileSync(first.path, 'utf8')).toBe(original);
  });

  it('skips whitespace-only messages without breaking parent links', () => {
    const imported = writeClaudeSessionImport(
      [history[0], { role: 'assistant', text: ' \n', at: history[0].at }, history[1]],
      root,
      projectDir,
    );
    const rows = records(imported.path);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.parentUuid).toBe(rows[0]?.uuid);
  });

  it.each(['system', 'thinking', 'tool'])(
    'refuses source %s records rather than importing them',
    (role) => {
      expect(() =>
        writeClaudeSessionImport(
          [{ role, text: 'excluded', at: history[0].at }] as NativeMigrationMessage[],
          root,
          projectDir,
        ),
      ).toThrow('only accepts');
      expect(existsSync(projectDir)).toBe(false);
    },
  );

  it.each([
    { messages: [] },
    { messages: [{ role: 'user', text: ' ', at: history[0].at }] },
    { messages: [history[1]] },
  ])('refuses history without meaningful user context', ({ messages }) => {
    expect(() =>
      writeClaudeSessionImport(messages as NativeMigrationMessage[], root, projectDir),
    ).toThrow();
    expect(existsSync(projectDir)).toBe(false);
  });

  it('validates every message before creating a file', () => {
    expect(() =>
      writeClaudeSessionImport(
        [...history, { role: 'assistant', text: 'bad', at: 'not-a-date' }],
        root,
        projectDir,
      ),
    ).toThrow('timestamp');
    expect(existsSync(projectDir)).toBe(false);
  });

  it('refuses relative workspace or destination paths', () => {
    expect(() => writeClaudeSessionImport(history, 'relative', projectDir)).toThrow('absolute cwd');
    expect(() => writeClaudeSessionImport(history, root, 'relative')).toThrow('absolute project');
    expect(existsSync(projectDir)).toBe(false);
  });

  it.skipIf(!process.env.ATEAM_TEST_CLAUDE_BIN)(
    'real Claude --resume sends imported history to an isolated loopback API',
    async () => {
      const claudeBin = process.env.ATEAM_TEST_CLAUDE_BIN;
      if (!claudeBin) throw new Error('ATEAM_TEST_CLAUDE_BIN must point to an isolated test CLI');
      const imported = writeClaudeSessionImport(history, root, projectDir);
      const received: { url: string | undefined; body: ApiRequest }[] = [];
      const server = createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        received.push({ url: request.url, body });
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify(
            request.url?.includes('count_tokens')
              ? { input_tokens: 100 }
              : {
                  id: 'msg_local_only',
                  type: 'message',
                  role: 'assistant',
                  model: 'claude-haiku-4-5',
                  content: [{ type: 'text', text: 'LOCAL_ONLY_RESUME_OK' }],
                  stop_reason: 'end_turn',
                  stop_sequence: null,
                  usage: { input_tokens: 100, output_tokens: 5 },
                },
          ),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as { port: number };
      const env: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(CLAUDE|ATEAM|ANTHROPIC|AI_AGENT)/.test(key),
        ),
      );
      Object.assign(env, {
        HOME: root,
        CLAUDE_CONFIG_DIR: join(root, 'claude'),
        ANTHROPIC_API_KEY: 'local-only-not-a-real-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        NO_PROXY: '127.0.0.1,localhost',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
      });
      try {
        const result = await new Promise<{ code: number | null; output: string }>(
          (resolve, reject) => {
            const child = spawn(
              claudeBin,
              [
                '--bare',
                '--setting-sources',
                '',
                '--strict-mcp-config',
                '--mcp-config',
                '{"mcpServers":{}}',
                '--tools',
                '',
                '--model',
                'haiku',
                '--resume',
                imported.sessionId,
                '-p',
                'LOCAL_NEW_USER: continue.',
              ],
              { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
            );
            let output = '';
            child.stdout.on('data', (chunk) => {
              output += chunk;
            });
            child.stderr.on('data', (chunk) => {
              output += chunk;
            });
            const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
            child.once('error', (error) => {
              clearTimeout(timeout);
              reject(error);
            });
            child.once('close', (code) => {
              clearTimeout(timeout);
              resolve({ code, output });
            });
          },
        );
        expect(result, result.output).toMatchObject({ code: 0 });
        expect(result.output).toContain('LOCAL_ONLY_RESUME_OK');
        const request = received.find(
          (entry) => entry.url?.includes('/messages') && !entry.url.includes('count_tokens'),
        );
        expect(request).toBeDefined();
        const text = JSON.stringify(request?.body.messages);
        for (const message of history)
          expect(text).toContain(JSON.stringify(message.text).slice(1, -1));
        for (const message of history) {
          expect(
            request?.body.messages?.some(
              (input) =>
                input.role === message.role &&
                JSON.stringify(input.content).includes(JSON.stringify(message.text).slice(1, -1)),
            ),
          ).toBe(true);
        }
        expect(text).not.toContain('"type":"tool_use"');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    20000,
  );
});
