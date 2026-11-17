import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readNativeMigrationMessages } from '../native-migration-source';
import { writeCodexSessionImport } from './codex-session-import';

const homes: string[] = [];
function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'ateam-codex-import-'));
  homes.push(root);
  return root;
}
afterEach(() => {
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native Codex import', () => {
  const messages = [
    { role: 'user' as const, text: 'Keep this request', at: '2026-10-08T10:00:00.000Z' },
    { role: 'assistant' as const, text: 'Keep this answer', at: '2026-10-08T10:00:01.000Z' },
  ];
  it('writes model-visible history as well as display events and preserves both roles', () => {
    const result = writeCodexSessionImport(messages, '/tmp', home());
    expect(basename(result.path)).toMatch(
      /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f-]{36}\.jsonl$/,
    );
    const records = readFileSync(result.path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({
      type: 'session_meta',
      payload: { id: result.sessionId, cwd: '/tmp' },
    });
    expect(records.filter((record) => record.type === 'response_item')).toHaveLength(2);
    expect(
      records.filter((record) => ['user_message', 'agent_message'].includes(record.payload.type)),
    ).toHaveLength(2);
    expect(readNativeMigrationMessages('codex', result.path)).toEqual(messages);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
  });
  it('creates independent sessions without overwriting an earlier migration', () => {
    const root = home();
    const first = writeCodexSessionImport(messages, '/tmp', root);
    const original = readFileSync(first.path, 'utf8');
    const second = writeCodexSessionImport(messages, '/tmp', root);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(readFileSync(first.path, 'utf8')).toBe(original);
  });
  it('refuses assistant-only or empty history', () => {
    expect(() => writeCodexSessionImport([], '/tmp', home())).toThrow('user history');
    expect(() => writeCodexSessionImport(messages.slice(1), '/tmp', home())).toThrow(
      'user history',
    );
  });

  it.skipIf(!process.env.ATEAM_TEST_CODEX_BIN)(
    'real Codex resume sends both imported roles to an isolated loopback provider',
    async () => {
      const root = home();
      const imported = writeCodexSessionImport(messages, tmpdir(), root);
      const requests: string[] = [];
      const server = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        requests.push(body);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const message = {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'LOCAL_RESUME_OK', annotations: [] }],
        };
        const event = (type: string, fields: Record<string, unknown>) =>
          response.write(`data: ${JSON.stringify({ type, ...fields })}\n\n`);
        event('response.created', {
          response: { id: 'resp_fixture', status: 'in_progress', output: [] },
        });
        event('response.output_item.added', {
          output_index: 0,
          item: { ...message, status: 'in_progress', content: [] },
        });
        event('response.output_text.delta', {
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          delta: 'LOCAL_RESUME_OK',
        });
        event('response.output_item.done', { output_index: 0, item: message });
        event('response.completed', {
          response: {
            id: 'resp_fixture',
            status: 'completed',
            output: [message],
            usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
          },
        });
        response.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      writeFileSync(
        join(root, 'config.toml'),
        `model = "gpt-5.3-codex"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "Local mock"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
      );
      try {
        const result = await new Promise<{ code: number | null; output: string }>(
          (resolve, reject) => {
            const child = spawn(
              process.env.ATEAM_TEST_CODEX_BIN as string,
              [
                'exec',
                'resume',
                imported.sessionId,
                'LOCAL_CONTINUATION',
                '--skip-git-repo-check',
                '--json',
              ],
              {
                cwd: tmpdir(),
                env: {
                  ...process.env,
                  CODEX_HOME: root,
                  HTTP_PROXY: '',
                  HTTPS_PROXY: '',
                  ALL_PROXY: '',
                  NO_PROXY: '127.0.0.1,localhost',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            );
            let output = '';
            child.stdout.on('data', (data) => {
              output += data;
            });
            child.stderr.on('data', (data) => {
              output += data;
            });
            const timeout = setTimeout(() => child.kill(), 15000);
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
        expect(result.output).toContain('LOCAL_RESUME_OK');
        const request = requests.find((body) => body.includes('LOCAL_CONTINUATION'));
        expect(request).toContain(messages[0]?.text);
        expect(request).toContain(messages[1]?.text);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    20000,
  );
});
