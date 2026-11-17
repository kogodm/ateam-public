/** Peer delivery belongs to the sidecar that owns the PTYs; this per-session
 *  MCP uses a file request/reply so it never needs a second RPC connection. */
import { type PeerRequest, ateamHome, requestPeer } from '@ateam/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function argOf(flag: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? '') : '';
}

const SESSION_ID = argOf('--session');
const server = new McpServer({ name: 'ateam-peers', version: '1.0.0' });

function text(s: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: s }] };
}

async function request(request: PeerRequest) {
  try {
    const reply = await requestPeer(ateamHome(), request);
    if (!reply.ok) return { ...text(reply.error), isError: true };
    return text(reply.sessions ? JSON.stringify(reply.sessions, null, 2) : (reply.message ?? ''));
  } catch (e) {
    return { ...text(e instanceof Error ? e.message : String(e)), isError: true };
  }
}

server.registerTool(
  'list_sessions',
  {
    title: 'List Ateam sessions',
    description:
      'List every other live Ateam session, Claude or Codex, with name, short id, provider, project directory, state, and model. Use its name or id with send_message.',
    inputSchema: {},
  },
  async () => request({ kind: 'list', from: SESSION_ID }),
);

server.registerTool(
  'send_message',
  {
    title: 'Send a message to an Ateam session',
    description:
      'Send a teammate request to any live Ateam session, Claude or Codex, or reply to the exact external: address supplied in an External MCP message. External replies are saved for that client only. Returns only after the sidecar confirms delivery; unknown or ambiguous names are errors.',
    inputSchema: {
      to: z.string().min(1).describe('Name/id from list_sessions, or the exact external: reply address from the received message.'),
      message: z.string().min(1).describe('The message to deliver.'),
      summary: z.string().optional().describe('Optional short summary.'),
    },
  },
  async ({ to, message, summary }) =>
    request({ kind: 'send', from: SESSION_ID, to, message, summary }),
);

const transport = new StdioServerTransport();
server.connect(transport).catch((e) => {
  process.stderr.write(`ateam-peers MCP failed to start: ${String(e)}\n`);
  process.exit(1);
});
