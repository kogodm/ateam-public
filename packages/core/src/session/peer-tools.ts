/** Keep the native tool names so every existing sender-side renderer applies. */
export function peerToolName(name: string): 'SendMessage' | 'ListAgents' | undefined {
  const match = /^mcp__ateam[-_]peers__(send_message|list_sessions)$/.exec(name);
  return match ? (match[1] === 'send_message' ? 'SendMessage' : 'ListAgents') : undefined;
}
