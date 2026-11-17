import { describe, expect, it } from 'vitest';
import { claudeAdapter } from './claude-adapter';
import type { ProviderBuildArgs } from './provider-adapter';

const base: ProviderBuildArgs = {
  sessionId: 'sess-1',
  sessionName: 'demo',
  cwd: '/tmp/x',
  appendSystemPrompt: '',
  mcpConfigPath: '',
};

describe('claudeAdapter.buildArgs', () => {
  it('spawns fresh with --session-id when not resuming', () => {
    expect(claudeAdapter.buildArgs(base)).toEqual(['--session-id', 'sess-1', '--name', 'demo']);
  });

  it('resumes with --resume', () => {
    expect(claudeAdapter.buildArgs({ ...base, resumeSessionId: 'old-1' })).toEqual([
      '--resume',
      'old-1',
    ]);
  });

  it('appends the initial prompt as a positional after a `--` terminator', () => {
    const args = claudeAdapter.buildArgs({
      ...base,
      appendSystemPrompt: 'recall',
      mcpConfigPath: '/tmp/mcp.json',
      initialPrompt: 'take over from here',
    });
    // prompt must be last, and immediately preceded by `--` so the variadic
    // `--mcp-config` can't swallow it as another config file (ENAMETOOLONG).
    expect(args[args.length - 1]).toBe('take over from here');
    expect(args[args.length - 2]).toBe('--');
    expect(args).toEqual([
      '--session-id',
      'sess-1',
      '--name',
      'demo',
      '--append-system-prompt',
      'recall',
      '--mcp-config',
      '/tmp/mcp.json',
      '--',
      'take over from here',
    ]);
  });

  it('omits the positional when there is no initial prompt', () => {
    expect(claudeAdapter.buildArgs(base)).not.toContain('');
  });
});
