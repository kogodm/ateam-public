const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function codexCommandLabel(parsed: unknown): string | undefined {
  if (!Array.isArray(parsed)) return undefined;
  const labels = parsed.slice(0, 20).map((value) => {
    const command = object(value);
    const path = typeof command.path === 'string' ? command.path : '';
    const name = typeof command.name === 'string' ? command.name : path;
    switch (command.type) {
      case 'read':
        return `Read ${name.split(/[\\/]/).at(-1) || 'file'}`;
      case 'list_files':
        return `List files${path ? ` in ${path}` : ''}`;
      case 'search':
        return `Search files${path ? ` in ${path}` : ''}`;
      default:
        return 'Run command';
    }
  });
  const unique = [...new Set(labels)];
  return unique.length ? unique.slice(0, 3).join(' · ').slice(0, 140) : undefined;
}

export function codexEventItem(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const id = payload.call_id;
  switch (payload.type) {
    case 'agent_reasoning':
      return { type: 'Reasoning', summary_text: [payload.text] };
    case 'context_compacted':
      return { type: 'ContextCompaction' };
    case 'sub_agent_activity':
      return { ...payload, type: 'SubAgentActivity' };
    case 'web_search_end':
      return { ...payload, id, type: 'WebSearch' };
    case 'image_generation_end':
      return { ...payload, id, type: 'ImageGeneration' };
    case 'mcp_tool_call_end': {
      const invocation = object(payload.invocation);
      const result = object(payload.result);
      return {
        ...invocation,
        id,
        type: 'McpToolCall',
        result: result.Ok ?? payload.result,
        error: result.Err,
      };
    }
    case 'entered_review_mode':
      return { ...payload, type: 'EnteredReviewMode' };
    case 'exited_review_mode':
      return { ...payload, type: 'ExitedReviewMode' };
    default:
      return undefined;
  }
}
