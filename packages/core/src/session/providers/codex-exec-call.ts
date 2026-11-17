import { parse } from 'acorn';

export type ExecCall =
  | { kind: 'exec_command'; cmd: string; cwd?: string }
  | { kind: 'write_stdin'; processId: string };
type Node = { type: string; [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
  !!value && typeof value === 'object' && 'type' in value;

function fromArgs(name: string, args: Record<string, unknown>): ExecCall | undefined {
  if (name === 'exec_command' && typeof args.cmd === 'string')
    return {
      kind: name,
      cmd: args.cmd,
      ...(typeof args.workdir === 'string' ? { cwd: args.workdir } : {}),
    };
  if (name === 'write_stdin' && /^(?:\d+)$/.test(String(args.session_id)))
    return { kind: name, processId: String(args.session_id) };
  return undefined;
}

export function codexExecCall(payload: Record<string, unknown>): ExecCall | undefined {
  if (payload.type === 'function_call') {
    try {
      return fromArgs(
        String(payload.name).split('.').at(-1) ?? '',
        JSON.parse(String(payload.arguments)),
      );
    } catch {
      return undefined;
    }
  }
  if (
    payload.type !== 'custom_tool_call' ||
    String(payload.name).split('.').at(-1) !== 'exec' ||
    typeof payload.input !== 'string' ||
    payload.input.length > 100000
  )
    return undefined;
  try {
    const root = parse(payload.input, { ecmaVersion: 'latest', sourceType: 'module' });
    const calls: (ExecCall | undefined)[] = [];
    let dynamic = false;
    const visit = (value: unknown, parent?: Node): void => {
      if (!isNode(value)) return;
      if (
        value.type === 'Identifier' &&
        value.name === 'tools' &&
        !(parent?.type === 'MemberExpression' && parent.object === value)
      )
        dynamic = true;
      if (
        value.type === 'MemberExpression' &&
        isNode(value.object) &&
        value.object.name === 'tools' &&
        !(parent?.type === 'CallExpression' && parent.callee === value)
      )
        dynamic = true;
      if (
        [
          'FunctionDeclaration',
          'FunctionExpression',
          'ArrowFunctionExpression',
          'ForStatement',
          'ForOfStatement',
          'WhileStatement',
          'DoWhileStatement',
        ].includes(value.type)
      ) {
        dynamic = true;
        return;
      }
      if (value.type === 'CallExpression' && isNode(value.callee)) {
        const callee = value.callee;
        if (
          callee.type === 'MemberExpression' &&
          isNode(callee.object) &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'tools'
        ) {
          if (callee.computed) dynamic = true;
          const name = isNode(callee.property) ? callee.property.name : undefined;
          if (name === 'exec_command' || name === 'write_stdin') {
            const argument = Array.isArray(value.arguments) ? value.arguments[0] : undefined;
            const args: Record<string, unknown> = {};
            if (
              isNode(argument) &&
              argument.type === 'ObjectExpression' &&
              Array.isArray(argument.properties)
            ) {
              for (const property of argument.properties) {
                if (
                  !isNode(property) ||
                  property.type !== 'Property' ||
                  property.computed ||
                  !isNode(property.key) ||
                  !isNode(property.value)
                ) {
                  dynamic = true;
                  continue;
                }
                const key = property.key.name ?? property.key.value;
                if (typeof key === 'string' && property.value.type === 'Literal')
                  args[key] = property.value.value;
                else if (
                  typeof key === 'string' &&
                  property.value.type === 'TemplateLiteral' &&
                  Array.isArray(property.value.expressions) &&
                  property.value.expressions.length === 0 &&
                  Array.isArray(property.value.quasis)
                )
                  args[key] = (
                    property.value.quasis[0] as { value?: { cooked?: string } }
                  )?.value?.cooked;
                else if (typeof key === 'string' && ['cmd', 'workdir', 'session_id'].includes(key))
                  dynamic = true;
              }
            }
            calls.push(fromArgs(name, args));
          }
        }
      }
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) {
          for (const entry of child) visit(entry, value);
        } else if (isNode(child)) visit(child, value);
      }
    };
    visit(root);
    return !dynamic && calls.length === 1 ? calls[0] : undefined;
  } catch {
    return undefined;
  }
}

export interface ExecResult {
  processId?: string;
  exitCode?: number;
  output: string;
}

export function codexExecBatch(
  payload: Record<string, unknown>,
): (ExecCall | undefined)[] | undefined {
  if (
    payload.type !== 'custom_tool_call' ||
    String(payload.name).split('.').at(-1) !== 'exec' ||
    typeof payload.input !== 'string' ||
    payload.input.length > 100000
  )
    return undefined;
  try {
    const root = parse(payload.input, { ecmaVersion: 'latest', sourceType: 'module' });
    const slots: (ExecCall | undefined)[] = [];
    const harmless = (value: unknown, parent?: Node): boolean => {
      if (!isNode(value)) return true;
      if (
        value.type === 'Identifier' &&
        value.name === 'tools' &&
        !(parent?.type === 'MemberExpression' && parent.object === value && !parent.computed)
      )
        return false;
      if (value.type === 'VariableDeclarator' && isNode(value.id) && value.id.name === 'image')
        return false;
      if (
        value.type === 'Identifier' &&
        ['text', 'notify', 'exec_command', 'write_stdin'].includes(String(value.name))
      )
        return false;
      if (['AssignmentExpression', 'UpdateExpression'].includes(value.type)) return false;
      if (value.type === 'CallExpression') {
        const callee = value.callee;
        if (
          !isNode(callee) ||
          (!(callee.type === 'Identifier' && callee.name === 'image') &&
            !(
              callee.type === 'MemberExpression' &&
              !callee.computed &&
              isNode(callee.object) &&
              callee.object.name === 'tools' &&
              isNode(callee.property) &&
              callee.property.name === 'view_image'
            ))
        )
          return false;
      }
      return Object.values(value).every((child) =>
        Array.isArray(child)
          ? child.every((entry) => harmless(entry, value))
          : harmless(child, value),
      );
    };
    for (const statement of root.body) {
      const expression =
        statement.type === 'ExpressionStatement' ? statement.expression : undefined;
      if (
        expression?.type === 'CallExpression' &&
        expression.callee.type === 'Identifier' &&
        expression.callee.name === 'text' &&
        expression.arguments.length === 1
      ) {
        const argument = expression.arguments[0];
        if (argument?.type !== 'AwaitExpression' || argument.argument.type !== 'CallExpression')
          return undefined;
        const callee = argument.argument.callee;
        if (
          callee.type !== 'MemberExpression' ||
          callee.computed ||
          callee.object.type !== 'Identifier' ||
          callee.object.name !== 'tools' ||
          callee.property.type !== 'Identifier'
        )
          return undefined;
        const call = codexExecCall({
          ...payload,
          input: payload.input.slice(statement.start, statement.end),
        });
        if (['exec_command', 'write_stdin'].includes(callee.property.name) && !call)
          return undefined;
        if (!call && !argument.argument.arguments.every((entry) => harmless(entry)))
          return undefined;
        slots.push(call);
      } else if (!harmless(statement)) return undefined;
    }
    return slots.some(Boolean) ? slots : undefined;
  } catch {
    return undefined;
  }
}

export function codexExecBatchResults(
  output: unknown,
  count: number,
): (ExecResult | undefined)[] | undefined {
  if (!Array.isArray(output)) return undefined;
  const texts: string[] = [];
  for (const part of output) {
    if (!part || typeof part !== 'object') return undefined;
    if (part.type === 'input_text' || part.type === 'text') {
      if (typeof part.text !== 'string') return undefined;
      texts.push(part.text);
    } else if (!['input_image', 'image'].includes(part.type)) return undefined;
  }
  if (texts[0] && /^Script completed\nWall time [^\n]+\nOutput:\n$/.test(texts[0])) texts.shift();
  return texts.length === count ? texts.map((text) => codexExecResult(text)) : undefined;
}

export function codexExecResult(output: unknown): ExecResult | undefined {
  const results: ExecResult[] = [];
  const collect = (value: unknown, depth: number): void => {
    if (depth > 3) return;
    if (typeof value === 'string') {
      try {
        collect(JSON.parse(value), depth + 1);
        return;
      } catch {}
      const header =
        /^(?:Chunk ID: [^\n]*\n)?Wall time: [^\n]*\n(?:Process running with session ID (\d+)|Process exited with code (-?\d+))\n(?:[^\n]*\n)*?Output:\n/.exec(
          value,
        );
      if (header)
        results.push({
          ...(header[1] ? { processId: header[1] } : { exitCode: Number(header[2]) }),
          output: value.slice(header[0].length),
        });
    } else if (Array.isArray(value)) {
      for (const part of value.slice(0, 100)) collect(part, depth + 1);
    } else if (value && typeof value === 'object') {
      const result = value as Record<string, unknown>;
      if (typeof result.output === 'string' && typeof result.wall_time_seconds === 'number') {
        const processId = /^(?:\d+)$/.test(String(result.session_id))
          ? String(result.session_id)
          : undefined;
        const exitCode =
          typeof result.exit_code === 'number' && Number.isInteger(result.exit_code)
            ? result.exit_code
            : undefined;
        if (processId || exitCode !== undefined)
          results.push({ processId, exitCode, output: result.output });
      } else if (
        (result.type === 'input_text' || result.type === 'text') &&
        typeof result.text === 'string'
      )
        collect(result.text, depth + 1);
    }
  };
  collect(output, 0);
  return results.length === 1 ? results[0] : undefined;
}
