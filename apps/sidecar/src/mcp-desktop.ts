/** Local stdio connector launched by ChatGPT/Claude Desktop; stdout is MCP only. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTERNAL_INSTRUCTIONS, EXTERNAL_TOOLS } from '@ateam/contract';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const credentialPath = arg('--credential');
const home = arg('--home');
if (
  !credentialPath ||
  !home ||
  !process.argv.includes('--credential') ||
  !process.argv.includes('--home')
)
  throw new Error('Missing desktop connection configuration.');
const { token } = JSON.parse(readFileSync(credentialPath, 'utf8')) as { token: string };
if (typeof token !== 'string' || token.length < 32)
  throw new Error('Invalid desktop connection credential.');

// Shared with the relay gateway; plain JSON, no imports (keeps this connector small).
const tools = EXTERNAL_TOOLS as Tool[];
function endpoint(): URL {
  const { url } = JSON.parse(
    readFileSync(join(home as string, 'external-mcp', 'endpoint.json'), 'utf8'),
  ) as { url: string };
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.pathname !== '/mcp' ||
    parsed.username ||
    parsed.password
  )
    throw new Error('Invalid local endpoint.');
  return parsed;
}
let client: Client | undefined;
let connectedUrl = '';
let connecting: Promise<Client> | undefined;
async function connectionStatus(): Promise<string> {
  const url = new URL('/connect', endpoint());
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
  });
  if (!response.ok) return 'unavailable';
  return ((await response.json()) as { status: string }).status;
}
async function remote(): Promise<Client> {
  if ((await connectionStatus()) !== 'approved')
    throw new Error(
      'Connection is not approved. Open Ateam and allow this client in the connection dialog; denied or expired requests can be retried in Settings → MCP.',
    );
  const url = endpoint();
  if (client && connectedUrl === url.href) return client;
  if (!connecting)
    connecting = (async () => {
      await client?.close();
      const next = new Client({ name: 'ateam-desktop-connector', version: '0.1.0' });
      await next.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      connectedUrl = url.href;
      client = next;
      return next;
    })().finally(() => {
      connecting = undefined;
    });
  return connecting;
}
const server = new Server(
  { name: 'ateam', version: '0.1.0' },
  {
    capabilities: { tools: {} },
    instructions: `The first connection must be approved in Ateam. Tool discovery works before that, but no project data, session data or operations are available until the user approves selected projects.\n\n${EXTERNAL_INSTRUCTIONS}`,
  },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    if (!tools.some((t) => t.name === params.name)) throw new Error('Unknown tool.');
    return await (await remote()).callTool(params);
  } catch (error) {
    return {
      isError: true,
      content: [
        { type: 'text', text: error instanceof Error ? error.message : 'Open Ateam to connect.' },
      ],
    };
  }
});
// Initiate consent when the client connects; never hold its MCP initialize handshake open.
const timer = setInterval(() => {
  void connectionStatus().catch(() => {});
}, 2000);
timer.unref();
server.onclose = () => {
  clearInterval(timer);
  void client?.close();
};
void server
  .connect(new StdioServerTransport())
  .then(() => connectionStatus())
  .catch(() => {
    process.stderr.write('Ateam desktop connector is waiting for the local app.\n');
  });
