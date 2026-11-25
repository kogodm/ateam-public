import { describe, expect, it } from 'vitest';
import { codexExecLabel } from './codexExecLabel';
import { codexToolLabel } from './codexToolLabel';

describe('nested Codex action labels', () => {
  it('reads namespaced calls inside wrappers and parallel operations', () => {
    expect(
      codexExecLabel('text(await tools.multi_agent_v1__wait_agent({targets: ["agent"]}));'),
    ).toBe('Wait for agents');
    expect(
      codexExecLabel(
        'const result = await tools.view_image({path: "a.png"}); image(result.image_url);',
      ),
    ).toBe('Viewed image');
    expect(
      codexExecLabel(
        'await Promise.all([tools.exec_command({cmd:"git diff"}),tools.apply_patch("patch")]);',
      ),
    ).toBe('Inspect changes · Apply changes');
  });
  it('prefers an action over unrelated preceding commentary', () => {
    expect(
      codexToolLabel(
        { toolName: 'functions.exec', text: 'await tools.exec_command({cmd:"cat file"});' },
        'Already verified the model settings',
      ),
    ).toBe('Read files');
  });
  it('ignores quoted code, comments, dynamic dispatch and malformed scripts', () => {
    for (const source of [
      'text("tools.apply_patch(1)")',
      '// tools.apply_patch(1)',
      'tools[name]({})',
      'function unused(){tools.apply_patch("x")}',
      'await tools.exec_command({',
    ])
      expect(codexExecLabel(source)).toBeUndefined();
  });
  it('does not execute scripts or expose command arguments', () => {
    expect(
      codexExecLabel(
        'throw new Error("never execute"); await tools.exec_command({cmd:"echo secret git push"})',
      ),
    ).toBe('Run command');
    expect(codexExecLabel('await tools.exec_command({cmd:"node script.mjs --token=secret"})')).toBe(
      'Run script',
    );
  });
  it('deduplicates actions and preserves unknown calls in mixed batches', () => {
    expect(
      codexExecLabel(
        'await tools.view_image({}); await tools.view_image({}); await tools.unknown({});',
      ),
    ).toBe('Viewed image · Run tool');
    expect(
      codexExecLabel(
        'await tools.exec_command({cmd:"rg term"}); await tools.write_stdin({chars:""});',
      ),
    ).toBe('Search files · Read command output');
  });
  it('bounds parsing input size', () => {
    expect(codexExecLabel(' '.repeat(100001))).toBeUndefined();
  });
});
