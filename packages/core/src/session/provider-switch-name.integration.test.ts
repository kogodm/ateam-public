import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node-pty';
import { expect, it, vi } from 'vitest';
import { storeTitle } from './provider-store';
import { preserveImportedSessionName } from './provider-switch';
import { writeCodexSessionImport } from './providers/codex-session-import';

it.skipIf(!process.env.ATEAM_TEST_CODEX_BIN).each([false, true])(
  'real interactive Codex resume native-name registration=%s after a completed turn',
  async (preserveName) => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-name-live-'));
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const message = {
        id: `msg_fixture_${requests.length}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'LOCAL_NAME_PROBE_OK', annotations: [] }],
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
        delta: 'LOCAL_NAME_PROBE_OK',
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
    let child: ReturnType<typeof spawn> | undefined;
    try {
      vi.stubEnv('CODEX_HOME', root);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      writeFileSync(
        join(root, 'config.toml'),
        [
          'model = "gpt-5.3-codex"',
          'model_provider = "mock"',
          'check_for_update_on_startup = false',
          '[model_providers.mock]',
          'name = "Local mock"',
          `base_url = "http://127.0.0.1:${port}/v1"`,
          'wire_api = "responses"',
          'requires_openai_auth = false',
          `[projects.${JSON.stringify(root)}]`,
          'trust_level = "trusted"',
        ].join('\n'),
      );
      const imported = writeCodexSessionImport(
        [
          { role: 'user', text: 'NAME_USER_SENTINEL', at: '2026-10-08T10:00:00.000Z' },
          { role: 'assistant', text: 'NAME_ASSISTANT_SENTINEL', at: '2026-10-08T10:00:01.000Z' },
        ],
        root,
        root,
      );
      const lines = readFileSync(imported.path, 'utf8').trim().split('\n');
      const meta = JSON.parse(lines[0] ?? '{}');
      meta.payload.model_provider = 'mock';
      lines[0] = JSON.stringify(meta);
      writeFileSync(imported.path, `${lines.join('\n')}\n`);
      const originalName = 'Original inherited name';
      if (preserveName) preserveImportedSessionName('codex', imported, originalName);
      const before = preserveName ? readFileSync(join(root, 'session_index.jsonl'), 'utf8') : '';
      console.log(`进度 1/3 isolated native title registration=${preserveName}`);
      let screen = '';
      child = spawn(
        process.env.ATEAM_TEST_CODEX_BIN as string,
        [
          'resume',
          imported.sessionId,
          'Continue migrated session NAME_CONTINUATION_SENTINEL',
          '--no-daemon',
          '--no-alt-screen',
          '-C',
          root,
          '-s',
          'read-only',
          '-a',
          'never',
          '-c',
          'model_provider="mock"',
          '-m',
          'gpt-5.3-codex',
        ],
        {
          cwd: root,
          cols: 100,
          rows: 30,
          name: 'xterm-256color',
          env: {
            ...process.env,
            HOME: root,
            CODEX_HOME: root,
            TERM: 'xterm-256color',
            OPENAI_API_KEY: '',
            CODEX_API_KEY: '',
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            ALL_PROXY: '',
            NO_PROXY: '127.0.0.1,localhost',
          },
        },
      );
      child.onData((data) => {
        screen += data;
        if (data.includes('\x1b[6n')) child?.write('\x1b[1;1R');
      });
      const deadline = Date.now() + 20_000;
      let completed = false;
      while (Date.now() < deadline) {
        const records = readFileSync(imported.path, 'utf8')
          .trim()
          .split('\n')
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          });
        completed =
          records.filter(
            (record) => record.type === 'event_msg' && record.payload?.type === 'task_complete',
          ).length > 1;
        if (completed) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(
        completed,
        `No completed turn; requests=${requests.length}; screen=${screen.slice(-1500)}`,
      ).toBe(true);
      expect(
        requests.some(
          (body) =>
            body.includes('NAME_USER_SENTINEL') &&
            body.includes('NAME_ASSISTANT_SENTINEL') &&
            body.includes('NAME_CONTINUATION_SENTINEL'),
        ),
      ).toBe(true);
      console.log('进度 2/3 real interactive turn completed through loopback mock');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (preserveName) {
        expect(existsSync(join(root, 'session_index.jsonl'))).toBe(true);
        expect(readFileSync(join(root, 'session_index.jsonl'), 'utf8')).toBe(before);
        expect(storeTitle('codex', root, imported.sessionId)).toBe(originalName);
        expect(screen).toContain(originalName);
      } else {
        expect(existsSync(join(root, 'session_index.jsonl'))).toBe(false);
        expect(storeTitle('codex', root, imported.sessionId)).toBe('');
      }
      console.log(`进度 3/3 native name result registration=${preserveName} verified`);
    } finally {
      child?.kill();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
