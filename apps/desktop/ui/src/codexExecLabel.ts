import { parse } from 'acorn';

type Node = { type: string; [key: string]: unknown };

function node(value: unknown): value is Node {
  return !!value && typeof value === 'object' && 'type' in value;
}

function literal(value: unknown): string | undefined {
  if (!node(value)) return undefined;
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value;
  return undefined;
}

function field(value: unknown, name: string): string | undefined {
  if (!node(value) || value.type !== 'ObjectExpression' || !Array.isArray(value.properties))
    return undefined;
  for (const property of value.properties) {
    if (!node(property) || property.computed || !node(property.key)) continue;
    if (property.key.name === name || literal(property.key) === name)
      return literal(property.value);
  }
  return undefined;
}

function commandLabel(command: string | undefined): string {
  if (!command) return 'Run command';
  if (/^\s*git\s+(?:commit|push)\b/.test(command)) return 'Commit or push changes';
  if (/^\s*(?:(?:pnpm|npm|npx)\s+(?:exec\s+)?(?:vitest|test)|pytest|cargo test)\b/.test(command))
    return 'Run tests';
  if (/^\s*(?:(?:pnpm|npm)\s+(?:exec\s+)?(?:typecheck|tsc)|tsc)\b/.test(command))
    return 'Check types';
  if (/^\s*git\s+diff\b/.test(command)) return 'Inspect changes';
  if (/^\s*git\s+status\b/.test(command)) return 'Check repository status';
  if (/^\s*(?:rg|grep)\s/.test(command)) return 'Search files';
  if (/^\s*(?:cat|sed|head|tail)\s/.test(command)) return 'Read files';
  if (/^\s*(?:node|python3?|bash|sh)\s/.test(command)) return 'Run script';
  return 'Run command';
}

function action(name: string, argument: unknown): string | undefined {
  switch (name.split('__').at(-1)) {
    case 'exec_command':
      return commandLabel(field(argument, 'cmd'));
    case 'apply_patch':
      return 'Apply changes';
    case 'view_image':
      return 'View image';
    case 'spawn_agent':
      return 'Start sub-agent';
    case 'send_input':
      return 'Send to agent';
    case 'wait_agent':
      return 'Wait for agents';
    case 'write_stdin':
      return field(argument, 'chars') ? 'Send command input' : 'Read command output';
    case 'web__run':
    case 'run':
      return name === 'web__run' ? 'Browse web' : undefined;
    default:
      return undefined;
  }
}

export function codexExecLabel(source: string): string | undefined {
  if (source.length > 100_000) return undefined;
  try {
    const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const actions: string[] = [];
    const visit = (value: unknown): void => {
      if (!node(value)) return;
      if (['FunctionDeclaration', 'FunctionExpression'].includes(value.type)) return;
      if (value.type === 'CallExpression' && node(value.callee)) {
        const callee = value.callee;
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          node(callee.object) &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'tools' &&
          node(callee.property) &&
          typeof callee.property.name === 'string'
        ) {
          const label = action(
            callee.property.name,
            Array.isArray(value.arguments) ? value.arguments[0] : undefined,
          );
          if (label) actions.push(label);
          else actions.push('Run tool');
        }
      }
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (node(child)) visit(child);
      }
    };
    visit(tree);
    const unique = [...new Set(actions)];
    if (!unique.length) return undefined;
    const label = unique.slice(0, 3).join(' · ');
    return unique.length > 3 ? `${label} · +${unique.length - 3} actions` : label;
  } catch {
    return undefined;
  }
}
