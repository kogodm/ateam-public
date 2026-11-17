import { codexExecLabel } from './codexExecLabel';

export function codexToolLabel(
  tool: { toolName?: string; text: string; label?: string },
  commentary?: string,
): string | undefined {
  if (tool.label?.trim()) return tool.label;

  if (tool.toolName?.split('.').at(-1) === 'exec') {
    const nested = codexExecLabel(tool.text);
    if (nested) return nested;
  }

  const description = commentary
    ?.split(/\r\n|\r|\n/, 1)[0]
    ?.replace(/\s+/g, ' ')
    .trim();
  if (description) return description.slice(0, 100);

  switch (tool.toolName?.split('.').at(-1)?.split('__').at(-1)) {
    case 'exec': {
      const input = tool.text.trimStart();
      if (input.startsWith('image(await tools.view_image(')) return 'View image';
      if (input.startsWith('text(await tools.exec_command(')) return 'Run command';
      return 'Run tools';
    }
    case 'Bash':
    case 'exec_command':
      return 'Run command';
    case 'view_image':
      return 'View image';
    case 'send_input':
      return 'Send to agent';
    case 'wait':
    case 'wait_agent':
      return 'Wait for result';
    case 'write_stdin':
      return 'Read command output';
    case 'apply_patch':
    case 'Edit':
      return 'Apply changes';
    default:
      return undefined;
  }
}
