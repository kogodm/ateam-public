import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ExternalAccess } from './external-access';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ateam-consent-test-')));
  homes.push(home);
  const script = join(home, 'mcp-desktop.cjs');
  writeFileSync(script, '// test');
  const config = join(home, 'claude.json');
  const access = new ExternalAccess(home, () => [home]);
  return { home, script, config, access };
}

it('registers without approval, merges existing config and backs it up only on change', () => {
  const { home, script, config, access } = fixture();
  writeFileSync(
    config,
    JSON.stringify({
      preferences: { theme: 'dark' },
      mcpServers: { existing: { command: 'old' } },
    }),
  );
  expect(access.registerClaude(config, process.execPath, script).restartRequired).toBe(true);
  const merged = JSON.parse(readFileSync(config, 'utf8'));
  expect(merged.preferences.theme).toBe('dark');
  expect(merged.mcpServers.existing.command).toBe('old');
  expect(access.approved()).toEqual([]);
  expect(access.registerClaude(config, process.execPath, script).restartRequired).toBe(false);
  expect(readdirSync(home).filter((p) => p.endsWith('.bak'))).toHaveLength(1);
  expect(JSON.stringify(access.status())).not.toContain('token');
});

it('registers Cursor Desktop independently, preserves config, backs up once and grants no projects', () => {
  const { home, script, access } = fixture();
  const config = join(home, '.cursor', 'mcp.json');
  mkdirSync(join(home, '.cursor'));
  writeFileSync(
    config,
    JSON.stringify({ preferences: { theme: 'dark' }, mcpServers: { other: { command: 'keep' } } }),
  );
  const claudeConfig = join(home, 'claude.json');
  access.registerClaude(claudeConfig, process.execPath, script);
  const cursor = access.registerCursorDesktop(config, process.execPath, script);
  const merged = JSON.parse(readFileSync(config, 'utf8'));
  expect(merged.preferences.theme).toBe('dark');
  expect(merged.mcpServers.other.command).toBe('keep');
  expect(merged.mcpServers.ateam).toEqual({
    command: process.execPath,
    args: [
      script,
      '--credential',
      join(home, 'external-mcp', 'cursor-desktop.json'),
      '--home',
      home,
    ],
  });
  expect(cursor.restartRequired).toBe(true);
  expect(access.approved()).toEqual([]);
  expect(access.status().clients.find((c) => c.id === 'cursor-desktop')?.projects).toEqual([]);
  const cursorCredential = JSON.parse(
    readFileSync(join(home, 'external-mcp', 'cursor-desktop.json'), 'utf8'),
  );
  const claudeCredential = JSON.parse(
    readFileSync(join(home, 'external-mcp', 'claude-desktop.json'), 'utf8'),
  );
  expect(cursorCredential.token).not.toBe(claudeCredential.token);
  const credentialPath = join(home, 'external-mcp', 'cursor-desktop.json');
  const configInode = statSync(config).ino;
  const credentialInode = statSync(credentialPath).ino;
  expect(access.registerCursorDesktop(config, process.execPath, script).restartRequired).toBe(
    false,
  );
  expect(statSync(config).ino).toBe(configInode);
  expect(statSync(credentialPath).ino).toBe(credentialInode);
  expect(readdirSync(join(home, '.cursor')).filter((p) => p.endsWith('.bak'))).toHaveLength(1);
});

it('fails closed for invalid Cursor Desktop config and unrelated ateam entries', () => {
  const { home, script, access } = fixture();
  const config = join(home, '.cursor', 'mcp.json');
  mkdirSync(join(home, '.cursor'));
  writeFileSync(config, '{broken');
  expect(() => access.registerCursorDesktop(config, process.execPath, script)).toThrow('invalid');
  expect(readFileSync(config, 'utf8')).toBe('{broken');
  const original = JSON.stringify({ mcpServers: { ateam: { command: 'other', args: [] } } });
  writeFileSync(config, original);
  expect(() => access.registerCursorDesktop(config, process.execPath, script)).toThrow('unrelated');
  expect(readFileSync(config, 'utf8')).toBe(original);
});

it('preserves a malformed Cursor credential without changing config or registering a new client', () => {
  const { home, script, access } = fixture();
  const config = join(home, '.cursor', 'mcp.json');
  mkdirSync(join(home, '.cursor'));
  const original = JSON.stringify({ mcpServers: { thirdParty: { command: 'keep' } } });
  writeFileSync(config, original);
  const credentialPath = join(home, 'external-mcp', 'cursor-desktop.json');
  writeFileSync(credentialPath, '{broken credential');

  expect(() => access.registerCursorDesktop(config, process.execPath, script)).toThrow(
    'credential is invalid',
  );
  expect(readFileSync(credentialPath, 'utf8')).toBe('{broken credential');
  expect(readFileSync(config, 'utf8')).toBe(original);
  expect(access.status().clients).toEqual([]);
});

it('requires explicit project consent, prevents duplicate prompts and persists grants', () => {
  const { home, script, config, access } = fixture();
  access.registerClaude(config, process.execPath, script);
  const credential = JSON.parse(
    readFileSync(join(home, 'external-mcp', 'claude-desktop.json'), 'utf8'),
  );
  const auth = `Bearer ${credential.token}`;
  expect(access.attempt('Bearer random')).toBeUndefined();
  expect(access.attempt(auth)).toBe('pending');
  expect(access.attempt(auth)).toBe('pending');
  expect(access.status().pending).toHaveLength(1);
  expect(access.approved()).toHaveLength(0);
  expect(() => access.decide('claude-desktop', true, ['/unauthorized'])).toThrow();
  expect(() => access.decide('claude-desktop', true, [])).toThrow();
  access.decide('claude-desktop', true, [home]);
  expect(access.approved()[0]?.projects).toEqual([home]);
  const restored = new ExternalAccess(home, () => [home]);
  expect(restored.authenticate(auth)?.status).toBe('approved');
  restored.revoke('claude-desktop');
  expect(restored.approved()).toEqual([]);
  expect(restored.attempt(auth)).toBe('revoked');
  expect(restored.status().pending).toEqual([]);
  restored.retry('claude-desktop');
  expect(restored.attempt(auth)).toBe('pending');
  restored.decide('claude-desktop', false, []);
  expect(restored.attempt(auth)).toBe('denied');
});

it('expires unanswered requests on restart and never approves implicitly', () => {
  const { home, script, config, access } = fixture();
  access.registerClaude(config, process.execPath, script);
  const credential = JSON.parse(
    readFileSync(join(home, 'external-mcp', 'claude-desktop.json'), 'utf8'),
  );
  access.attempt(`Bearer ${credential.token}`);
  const restored = new ExternalAccess(home, () => [home]);
  expect(restored.status().clients[0]?.status).toBe('expired');
  expect(restored.approved()).toEqual([]);
});

it('registers ChatGPT in the actual MCP configuration and verifies the client result', () => {
  const { home, script, config, access } = fixture();
  access.registerClaude(config, process.execPath, script);
  const calls: string[][] = [];
  let entry:
    | {
        name: string;
        enabled: boolean;
        transport: { type: string; command: string; args: string[] };
      }
    | undefined;
  const run = (args: string[]) => {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify(entry ? [entry] : []);
    if (args[1] === 'add') {
      entry = {
        name: 'ateam',
        enabled: true,
        transport: { type: 'stdio', command: args[4] ?? '', args: args.slice(5) },
      };
      return 'added';
    }
    return JSON.stringify(entry);
  };
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex/config.toml'), 'model = "existing-model"\n');
  const installed = access.registerChatgpt(home, process.execPath, script, run);
  expect(installed.path).toBe(join(home, '.codex/config.toml'));
  expect(calls.some((args) => args[1] === 'add')).toBe(true);
  expect(entry?.transport.args).toContain(script);
  expect(access.status().clients.map((c) => c.id)).toEqual(['claude-desktop', 'chatgpt']);
  expect(access.status().clients[1]?.connected).toBe(false);
  expect(access.approved()).toEqual([]);
  expect(access.registerChatgpt(home, process.execPath, script, run).restartRequired).toBe(false);
  expect(calls.filter((args) => args[1] === 'add')).toHaveLength(1);
  expect(readdirSync(join(home, '.codex')).filter((f) => f.endsWith('.bak'))).toHaveLength(1);
});

it('does not overwrite an unrelated ChatGPT MCP entry or claim success without readback', () => {
  const { home, script, access } = fixture();
  expect(() =>
    access.registerChatgpt(home, process.execPath, script, () =>
      JSON.stringify([
        { name: 'ateam', enabled: true, transport: { type: 'stdio', command: 'other', args: [] } },
      ]),
    ),
  ).toThrow('unrelated');
  expect(() =>
    access.registerChatgpt(home, process.execPath, script, (args) =>
      args[1] === 'list' ? '[]' : '{}',
    ),
  ).toThrow('did not confirm');
});

it('does not overwrite malformed or unrelated client configurations', () => {
  const { script, config, access } = fixture();
  writeFileSync(config, '{broken');
  expect(() => access.registerClaude(config, process.execPath, script)).toThrow();
  expect(readFileSync(config, 'utf8')).toBe('{broken');
  const original = JSON.stringify({ mcpServers: { ateam: { command: 'someone-else' } } });
  writeFileSync(config, original);
  expect(() => access.registerClaude(config, process.execPath, script)).toThrow('unrelated');
  expect(readFileSync(config, 'utf8')).toBe(original);
});

it('preserves corrupt consent storage without preventing the rest of the app from starting', () => {
  const { home, script, config } = fixture();
  const file = join(home, 'external-mcp', 'access.json');
  writeFileSync(file, '{corrupt');
  const access = new ExternalAccess(home, () => [home]);
  expect(access.status().error).toContain('unreadable');
  expect(() => access.registerClaude(config, process.execPath, script)).toThrow('unreadable');
  expect(readFileSync(file, 'utf8')).toBe('{corrupt');
  expect(access.approved()).toEqual([]);
});

it('re-arms an expired request on the next attempt but never a denied one', () => {
  const { home, script, config, access } = fixture();
  access.registerClaude(config, process.execPath, script);
  const credential = JSON.parse(
    readFileSync(join(home, 'external-mcp', 'claude-desktop.json'), 'utf8'),
  );
  const auth = `Bearer ${credential.token}`;
  access.attempt(auth);
  const restored = new ExternalAccess(home, () => [home]);
  expect(restored.status().clients[0]?.status).toBe('expired');
  expect(restored.attempt(auth)).toBe('pending');
  expect(restored.status().pending).toHaveLength(1);
  restored.decide('claude-desktop', false, []);
  expect(restored.attempt(auth)).toBe('denied');
});
