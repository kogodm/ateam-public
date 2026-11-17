import { describe, expect, it } from 'vitest';
import { codexToolLabel } from './codexToolLabel';

describe('codexToolLabel', () => {
  it('preserves the original label ahead of commentary and tool mapping', () => {
    const label = `Original  label ${'x'.repeat(100)}`;
    expect(codexToolLabel({ toolName: 'exec', text: '', label }, 'Read files')).toBe(label);
  });

  it('uses only the commentary first line, collapsing whitespace', () => {
    expect(
      codexToolLabel(
        { toolName: 'exec', text: '', label: ' \t' },
        '  Read\t the   files  \r\nIgnore this',
      ),
    ).toBe('Read the files');
    expect(codexToolLabel({ text: '' }, 'Read files\rIgnore this')).toBe('Read files');
    expect(codexToolLabel({ toolName: 'exec', text: '' }, '\nRead files')).toBe('Run tools');
  });

  it('truncates normalized commentary to 100 characters', () => {
    expect(codexToolLabel({ text: '' }, `  ${'x'.repeat(101)}\nSecond line`)).toBe('x'.repeat(100));
    expect(codexToolLabel({ text: '' }, 'x'.repeat(100))).toBe('x'.repeat(100));
  });

  it.each([
    ['exec', 'Run tools'],
    ['functions.exec', 'Run tools'],
    ['functions.view_image', 'View image'],
    ['multi_agent_v1__wait_agent', 'Wait for result'],
    ['Bash', 'Run command'],
    ['exec_command', 'Run command'],
    ['view_image', 'View image'],
    ['send_input', 'Send to agent'],
    ['wait', 'Wait for result'],
    ['wait_agent', 'Wait for result'],
    ['write_stdin', 'Read command output'],
    ['apply_patch', 'Apply changes'],
    ['Edit', 'Apply changes'],
  ])('maps %s to %s without a description', (toolName, expected) => {
    expect(codexToolLabel({ toolName, text: '' }, ' \t')).toBe(expected);
  });

  it.each(['exec', 'functions.exec'])(
    'recognizes only explicit wrapper prefixes for %s',
    (toolName) => {
      expect(
        codexToolLabel({ toolName, text: 'image(await tools.view_image({path: "a.png"}));' }),
      ).toBe('View image');
      expect(
        codexToolLabel({ toolName, text: '  text(await tools.exec_command({cmd: "pwd"}));' }),
      ).toBe('Run command');
      expect(
        codexToolLabel(
          { toolName, text: 'image(await tools.view_image({}));', label: 'Inspect screenshot' },
          'Read files',
        ),
      ).toBe('Inspect screenshot');
      expect(
        codexToolLabel(
          { toolName, text: 'text(await tools.exec_command({}));' },
          'Inspect configuration',
        ),
      ).toBe('Run command');
    },
  );

  it.each([
    'text("exec_command view_image Bash")',
    'text("text(await tools.exec_command({}))")',
    '"image(await tools.view_image({}))"',
    '// image(await tools.view_image({}))',
    'text({description: "Model description"})',
  ])('does not infer a tool or description from embedded or quoted names: %s', (text) => {
    expect(codexToolLabel({ toolName: 'exec', text })).toBe('Run tools');
  });

  it('returns undefined for unknown tools, preserving the old fallback', () => {
    expect(
      codexToolLabel({ toolName: 'unknown', text: 'text(await tools.exec_command({}))' }),
    ).toBeUndefined();
    expect(codexToolLabel({ text: 'image(await tools.view_image({}))' })).toBeUndefined();
    expect(codexToolLabel({ toolName: '"exec_command"', text: '' })).toBeUndefined();
    expect(codexToolLabel({ toolName: 'unknown', text: '', label: 'Existing label' })).toBe(
      'Existing label',
    );
    expect(codexToolLabel({ toolName: 'unknown', text: '' }, 'Explain the action')).toBe(
      'Explain the action',
    );
  });
});
