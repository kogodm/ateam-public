import { describe, expect, it } from 'vitest';
import { getPrompt } from '../../prompts';
import { claudeAdapter } from './claude-adapter';
import { codexAdapter } from './codex-adapter';
import type { ProviderBuildArgs } from './provider-adapter';

const base: ProviderBuildArgs = {
  sessionId: '11111111-2222-4333-8444-555555555555',
  sessionName: 'proj',
  cwd: '/w',
  appendSystemPrompt: '',
  mcpConfigPath: '',
};

describe("the Human's model binding reaches the CLI", () => {
  it('claude gets --model before the system prompt, and nothing when unbound', () => {
    const withModel = claudeAdapter.buildArgs({ ...base, model: 'sonnet' });
    expect(withModel).toContain('--model');
    expect(withModel[withModel.indexOf('--model') + 1]).toBe('sonnet');
    expect(claudeAdapter.buildArgs(base)).not.toContain('--model');
  });

  it('a resumed claude session keeps the binding', () => {
    const args = claudeAdapter.buildArgs({
      ...base,
      resumeSessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
      model: 'claude-fable-5-1',
    });
    expect(args[args.indexOf('--model') + 1]).toBe('claude-fable-5-1');
  });

  it('a binding for the other runtime is not passed on (codex -m sonnet is a 400 every turn)', () => {
    expect(codexAdapter.buildArgs({ ...base, model: 'sonnet' })).not.toContain('-m');
    expect(codexAdapter.buildArgs({ ...base, model: 'claude-fable-5-1' })).not.toContain('-m');
    expect(codexAdapter.buildArgs({ ...base, model: 'opus[1m]' })).not.toContain('-m');
    expect(claudeAdapter.buildArgs({ ...base, model: 'gpt-5.6-sol' })).not.toContain('--model');
    expect(claudeAdapter.buildArgs({ ...base, model: 'o3' })).not.toContain('--model');
  });

  it('codex uses -m, and the initial prompt stays last', () => {
    const args = codexAdapter.buildArgs({ ...base, model: 'gpt-5.6-sol', initialPrompt: 'go' });
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-sol');
    expect(args.at(-1)).toBe('go');
    expect(codexAdapter.buildArgs(base)).not.toContain('-m');
  });

  it("codex mounts the Human's recall as invocation-scoped developer instructions", () => {
    const recall = 'Read meta at /Users/me/.ateam/meta.\nName: "Weber"';
    const args = codexAdapter.buildArgs({
      ...base,
      appendSystemPrompt: recall,
      initialPrompt: 'start the task',
    });
    expect(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2)).toEqual([
      '-c',
      `developer_instructions=${JSON.stringify(`${recall}\n\n${getPrompt('codexProgress').trim()}`)}`,
    ]);
    expect(args.at(-1)).toBe('start the task');
  });

  it('adds the Codex progress policy even without a Human recall, including on resume', () => {
    for (const config of [base, { ...base, resumeSessionId: base.sessionId }]) {
      const args = codexAdapter.buildArgs(config);
      expect(args).toContain(
        `developer_instructions=${JSON.stringify(getPrompt('codexProgress').trim())}`,
      );
    }
    expect(getPrompt('codexProgress')).toContain('普通主会话');
    expect(getPrompt('codexProgress')).toContain('后台任务');
    expect(getPrompt('codexProgress')).toContain('子 agent');
  });
});
