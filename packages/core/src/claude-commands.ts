import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderId } from '@ateam/contract';
import { listCodexSlashCommands } from './codex-commands';

export interface SlashCommand {
  name: string;
  description?: string;
  source: 'builtin' | 'user' | 'project';
}

/** The built-in commands worth suggesting — curated, not exhaustive: the
 *  stream composer's palette is for the ones a phone user actually reaches
 *  for. (claude's own palette is TUI-internal and not enumerable.) */
const BUILTINS: readonly SlashCommand[] = [
  { name: 'help', description: 'commands + shortcuts', source: 'builtin' },
  { name: 'model', description: 'switch model', source: 'builtin' },
  { name: 'clear', description: 'start a fresh conversation', source: 'builtin' },
  { name: 'compact', description: 'summarize + shrink context', source: 'builtin' },
  { name: 'resume', description: 'pick an earlier conversation', source: 'builtin' },
  { name: 'rename', description: 'name this session', source: 'builtin' },
  { name: 'usage', description: 'plan usage + limits', source: 'builtin' },
  { name: 'cost', description: 'token spend this session', source: 'builtin' },
  { name: 'effort', description: 'reasoning effort level', source: 'builtin' },
  { name: 'status', description: 'session + account status', source: 'builtin' },
  { name: 'config', description: 'settings', source: 'builtin' },
  { name: 'memory', description: 'edit memory files', source: 'builtin' },
  { name: 'mcp', description: 'MCP servers', source: 'builtin' },
  { name: 'agents', description: 'background agents', source: 'builtin' },
  { name: 'review', description: 'review a PR / branch', source: 'builtin' },
  { name: 'release-notes', description: "what's new", source: 'builtin' },
];

const frontmatterDescription = (file: string): string | undefined => {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 2000);
    const m = /^description:\s*(.+)$/m.exec(head);
    return m?.[1]?.trim().slice(0, 120);
  } catch {
    return undefined;
  }
};

/** One level of namespacing, mirroring claude: commands/foo.md → /foo,
 *  commands/ns/foo.md → /ns:foo. */
function scanCommandsDir(dir: string, source: 'user' | 'project'): SlashCommand[] {
  if (!existsSync(dir)) return [];
  const out: SlashCommand[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.md')) {
      out.push({
        name: e.name.slice(0, -3),
        description: frontmatterDescription(join(dir, e.name)),
        source,
      });
    } else if (e.isDirectory()) {
      try {
        for (const f of readdirSync(join(dir, e.name))) {
          if (!f.endsWith('.md')) continue;
          out.push({
            name: `${e.name}:${f.slice(0, -3)}`,
            description: frontmatterDescription(join(dir, e.name, f)),
            source,
          });
        }
      } catch {
        /* unreadable namespace dir */
      }
    }
  }
  return out;
}

/** Everything the composer's slash palette can offer for a session in
 *  `cwd`: project commands shadow user commands shadow builtins. */
export function listSlashCommands(cwd?: string, providerId: ProviderId = 'claude'): SlashCommand[] {
  if (providerId === 'codex') return listCodexSlashCommands();
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  const add = (cmds: SlashCommand[]): void => {
    for (const c of cmds) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      out.push(c);
    }
  };
  if (cwd) add(scanCommandsDir(join(cwd, '.claude', 'commands'), 'project'));
  add(scanCommandsDir(join(homedir(), '.claude', 'commands'), 'user'));
  add([...BUILTINS]);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
