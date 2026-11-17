import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { installChatgptPlugin } from './chatgpt-plugin';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup(
  options: { discover?: boolean; install?: boolean; disabled?: boolean; conflict?: boolean } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'ateam-plugin-test-'));
  homes.push(home);
  const root = join(home, 'external-mcp', 'plugin-marketplace');
  let installed = !!options.disabled;
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[1] === 'marketplace' && args[2] === 'list')
      return options.conflict ? 'ateam /other/owner' : `MARKETPLACE ROOT\nateam ${root}`;
    if (args[1] === 'marketplace') return '{}';
    if (args[1] === 'add') {
      installed = options.install !== false;
      return '{}';
    }
    const entry = { pluginId: 'ateam@ateam', installed, enabled: !options.disabled };
    return JSON.stringify({
      installed: installed ? [entry] : [],
      available: !installed && options.discover !== false ? [entry] : [],
    });
  };
  const args = {
    home,
    node: '/bundle/node',
    script: '/bundle/mcp-desktop.cjs',
    sourceRoot: resolve('.'),
    run,
  };
  return { args, calls, root };
}

it('materializes all four files, registers a marketplace, installs and reads back the plugin', () => {
  const { args, calls, root } = setup();
  const result = installChatgptPlugin(args);
  expect(result).toMatchObject({
    packageWritten: true,
    marketplaceRegistered: true,
    discovered: true,
    installed: true,
    ordinaryChatVerified: false,
  });
  expect(calls.some((c) => c[1] === 'add' && c[2] === 'ateam@ateam')).toBe(true);
  const marketplace = JSON.parse(
    readFileSync(join(root, '.agents/plugins/marketplace.json'), 'utf8'),
  );
  const plugin = join(root, marketplace.plugins[0].source.path);
  const manifest = JSON.parse(readFileSync(join(plugin, '.codex-plugin/plugin.json'), 'utf8'));
  expect(manifest.skills).toBe('./skills/');
  const mcp = JSON.parse(readFileSync(join(plugin, manifest.mcpServers), 'utf8'));
  expect(mcp.mcpServers.ateam.command).toBe('/bundle/node');
  expect(mcp.mcpServers.ateam.args).toContain(join(args.home, 'external-mcp/chatgpt.json'));
  expect(readFileSync(join(plugin, 'skills/ateam/SKILL.md'), 'utf8')).toMatch(/^---\nname: ateam/);
  expect(installChatgptPlugin(args).installed).toBe(true);
});

it('does not confuse a marketplace write or a successful add command with confirmed installation', () => {
  const undiscovered = installChatgptPlugin(setup({ discover: false }).args);
  expect(undiscovered.marketplaceRegistered).toBe(true);
  expect(undiscovered.installed).toBe(false);
  expect(undiscovered.error).toContain('did not discover');
  const uninstalled = installChatgptPlugin(setup({ install: false }).args);
  expect(uninstalled.discovered).toBe(true);
  expect(uninstalled.installed).toBe(false);
  expect(uninstalled.ordinaryChatVerified).toBe(false);
});

it('preserves user-disabled plugins and refuses marketplace ownership conflicts', () => {
  const disabled = setup({ disabled: true });
  expect(installChatgptPlugin(disabled.args).error).toContain('disabled');
  expect(disabled.calls.some((c) => c[1] === 'add')).toBe(false);
  const conflict = installChatgptPlugin(setup({ conflict: true }).args);
  expect(conflict.packageWritten).toBe(false);
  expect(conflict.error).toContain('another directory');
});

it('reports missing source assets without claiming MCP or ordinary Chat installation', () => {
  const { args } = setup();
  const result = installChatgptPlugin({ ...args, sourceRoot: join(args.home, 'missing') });
  expect(result.packageWritten).toBe(false);
  expect(result.installed).toBe(false);
  expect(result.ordinaryChatVerified).toBe(false);
});
