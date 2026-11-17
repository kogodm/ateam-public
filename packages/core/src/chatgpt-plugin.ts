import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ChatgptPluginStatus } from '@ateam/contract';

type Entry = { pluginId: string; installed?: boolean; enabled?: boolean };
type Listing = { installed: Entry[]; available: Entry[] };

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Discovery, installation and ordinary Chat validation are deliberately separate facts. */
export function installChatgptPlugin(args: {
  home: string;
  node: string;
  script: string;
  run: (args: string[]) => string;
  sourceRoot?: string;
}): ChatgptPluginStatus {
  const { home, node, script, run } = args;
  const root = join(home, 'external-mcp', 'plugin-marketplace');
  const name = home.endsWith('.ateam-debug') ? 'ateam-debug' : 'ateam';
  const pluginId = `ateam@${name}`;
  const status: ChatgptPluginStatus = {
    packageWritten: false,
    marketplaceRegistered: false,
    discovered: false,
    installed: false,
    ordinaryChatVerified: false,
    marketplaceRoot: root,
    pluginId,
  };
  try {
    const bundled = join(dirname(script), 'plugin-marketplace');
    const source =
      args.sourceRoot ?? (existsSync(join(bundled, 'plugins/ateam')) ? bundled : process.cwd());
    const manifest = JSON.parse(
      readFileSync(join(source, 'plugins/ateam/.codex-plugin/plugin.json'), 'utf8'),
    );
    const mcp = JSON.parse(readFileSync(join(source, 'plugins/ateam/.mcp.json'), 'utf8'));
    const marketplace = JSON.parse(
      readFileSync(join(source, '.agents/plugins/marketplace.json'), 'utf8'),
    );
    const skill = readFileSync(join(source, 'plugins/ateam/skills/ateam/SKILL.md'), 'utf8');
    if (
      manifest.name !== 'ateam' ||
      manifest.skills !== './skills/' ||
      manifest.mcpServers !== './.mcp.json' ||
      !mcp.mcpServers?.ateam ||
      marketplace.plugins?.length !== 1 ||
      marketplace.plugins[0]?.source?.path !== './plugins/ateam' ||
      !skill.startsWith('---\n')
    )
      throw new Error('Incomplete Ateam plugin package.');
    const marker = join(root, '.ateam-owner');
    if (existsSync(root) && (!existsSync(marker) || readFileSync(marker, 'utf8') !== home))
      throw new Error('Marketplace directory belongs to another installation.');
    // Check named marketplace ownership before asking the CLI to register/update it.
    const known = run(['plugin', 'marketplace', 'list'])
      .split('\n')
      .map((line) => line.trim().match(/^(\S+)\s+(.+)$/))
      .find((m) => m?.[1] === name);
    if (known?.[2] && resolve(known[2]) !== resolve(root))
      throw new Error(`Marketplace ${name} belongs to another directory.`);
    write(marker, home);
    mcp.mcpServers.ateam = {
      type: 'stdio',
      command: node,
      args: [script, '--credential', join(home, 'external-mcp/chatgpt.json'), '--home', home],
    };
    write(join(root, 'plugins/ateam/.codex-plugin/plugin.json'), JSON.stringify(manifest, null, 2));
    write(join(root, 'plugins/ateam/.mcp.json'), JSON.stringify(mcp, null, 2));
    write(join(root, 'plugins/ateam/skills/ateam/SKILL.md'), skill);
    write(
      join(root, '.agents/plugins/marketplace.json'),
      JSON.stringify({ ...marketplace, name }, null, 2),
    );
    status.packageWritten = true;
    run(['plugin', 'marketplace', 'add', root, '--json']);
    status.marketplaceRegistered = true;
    const list = (): Listing => {
      const data = JSON.parse(
        run(['plugin', 'list', '--marketplace', name, '--available', '--json']),
      );
      if (!Array.isArray(data.installed) || !Array.isArray(data.available))
        throw new Error('Invalid plugin inventory response.');
      return data;
    };
    const before = list();
    status.discovered = [...before.installed, ...before.available].some(
      (p) => p.pluginId === pluginId,
    );
    if (!status.discovered)
      throw new Error('Marketplace registered, but the client did not discover the Ateam plugin.');
    const previous = before.installed.find((p) => p.pluginId === pluginId);
    if (previous?.enabled === false)
      throw new Error('The Ateam plugin is disabled in the client. Enable it in Plugins.');
    run(['plugin', 'add', pluginId, '--json']);
    status.installed = list().installed.some(
      (p) => p.pluginId === pluginId && p.installed === true && p.enabled === true,
    );
    if (!status.installed)
      throw new Error('Client has not confirmed that the plugin is installed and enabled.');
  } catch (error) {
    status.error = error instanceof Error ? error.message : 'Plugin registration failed.';
  }
  return status;
}
