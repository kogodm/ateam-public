/** Only semantic CLI events open the external input gate. Unknown stays queued. */
export function externalReadiness(provider: string, lines: string[]): 'ready' | 'busy' | 'unknown' {
  for (let i = lines.length - 1; i >= 0; i--) {
    let r: {
      type?: string;
      subtype?: string;
      isSidechain?: boolean;
      payload?: { type?: string };
      message?: { stop_reason?: string };
    };
    try {
      r = JSON.parse(lines[i] ?? '');
    } catch {
      return 'unknown';
    }
    if (!r || typeof r !== 'object') return 'unknown';
    if (provider === 'codex') {
      if (r.type !== 'event_msg') continue;
      if (['task_complete', 'turn_complete', 'turn_aborted'].includes(r.payload?.type ?? ''))
        return 'ready';
      if (['task_started', 'turn_started', 'user_message'].includes(r.payload?.type ?? ''))
        return 'busy';
    } else if (provider === 'claude') {
      if (r.isSidechain) continue;
      if (r.type === 'system' && r.subtype === 'turn_duration') return 'ready';
      if (r.type === 'assistant')
        return ['end_turn', 'stop_sequence'].includes(r.message?.stop_reason ?? '')
          ? 'ready'
          : 'busy';
      if (r.type === 'user') return 'busy';
    } else return 'unknown';
  }
  return 'unknown';
}
