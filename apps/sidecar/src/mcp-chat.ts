/**
 * `ateam-chat` — the MCP server ATeam attaches to a teammate's session when
 * that session is the backing worker for a chat (see chat mode). It lets the
 * teammate speak into the chat the user is watching, WITHOUT the user seeing
 * the raw transcript underneath.
 *
 * Launched by the session's `--mcp-config` as:
 *   node mcp-chat.cjs --chat <chatId> --human <humanId> --session <sessionId>
 *
 * Design intent baked into the tool descriptions: messages stay SHORT, like a
 * real teammate — report progress at milestones, ask for help only at a real
 * blocker, and DELIVER DOCUMENTS AS LINKS (write the file under the chat's
 * working directory, then send its path) rather than pasting long text into the chat.
 * The same `~/.ateam/chats/<chatId>.jsonl` the desktop reads; the desktop
 * watches the dir and refreshes live.
 */
import { isAbsolute, join } from 'node:path';
import { appendMessage, getChat, readMessages } from '@ateam/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function argOf(flag: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? '') : '';
}

const CHAT_ID = argOf('--chat');
const HUMAN_ID = argOf('--human');

function text(s: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: s }] };
}

const server = new McpServer({ name: 'ateam-chat', version: '1.0.0' });

server.registerTool(
  'chat_say',
  {
    title: 'Say something in the chat',
    description:
      'Post a SHORT message to the chat the user is watching. This is the only ' +
      'thing the user sees of your work. FORMAT: one plain line saying what is ' +
      'done, then AT MOST 4 bullet lines starting with "- ", one fact each, ' +
      'under ~12 words. Never a dense paragraph, never a run-on list of every ' +
      'detail — the user reads this on a phone. Leave out what they did not ask ' +
      'about; the file is the record, not this message. Conversation with the ' +
      'user is handled by your chat side, so do not answer questions or ' +
      'acknowledge here. Do NOT paste output or code; deliver documents with ' +
      "chat_attach. Use kind:'status' for an in-progress note and kind:'result' " +
      'when done.',
    inputSchema: {
      text: z
        .string()
        .min(1)
        .describe('One line, then at most 4 short "- " bullets. No paragraphs.'),
      kind: z
        .enum(['text', 'status', 'result'])
        .optional()
        .describe("'status' = progress note; 'result' = finished deliverable; default 'text'."),
    },
  },
  async ({ text: msg, kind }) => {
    if (!CHAT_ID) return text('no chat bound to this session');
    appendMessage({ chatId: CHAT_ID, from: HUMAN_ID || 'user', kind: kind ?? 'text', text: msg });
    return text('sent');
  },
);

server.registerTool(
  'chat_attach',
  {
    title: 'Deliver a document as a link',
    description:
      'Deliver a document to the chat as a LINK, not inline text. First write ' +
      "the file under the chat's working directory, then call this with its " +
      'absolute path and a short note. The user gets a clickable link plus your ' +
      'note — this is how you hand over reports, plans, generated files, etc.',
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Path to the file — absolute, or relative to the chat's working directory."),
      note: z.string().optional().describe('A short line describing what it is.'),
      name: z.string().optional().describe('Link label; defaults to the file name.'),
    },
  },
  async ({ path, note, name }) => {
    if (!CHAT_ID) return text('no chat bound to this session');
    // Resolve to an absolute path so the desktop can open it — a teammate
    // often sends a path relative to the chat's working directory.
    const chat = getChat(CHAT_ID);
    const abs = isAbsolute(path) ? path : join(chat?.workdir || process.cwd(), path);
    const label = name?.trim() || (abs.split('/').pop() ?? abs);
    appendMessage({
      chatId: CHAT_ID,
      from: HUMAN_ID || 'user',
      kind: 'result',
      text: note?.trim() || `Here is ${label}.`,
      attachments: [{ name: label, path: abs }],
    });
    return text('delivered');
  },
);

server.registerTool(
  'chat_read',
  {
    title: 'Read recent chat messages',
    description:
      'Read the latest messages in this chat (to catch up on what the user or ' +
      'other teammates said). Optionally pass sinceTs (epoch ms) to get only ' +
      'messages newer than that.',
    inputSchema: {
      sinceTs: z.number().optional().describe('Only messages with ts greater than this.'),
    },
  },
  async ({ sinceTs }) => {
    if (!CHAT_ID) return text('no chat bound to this session');
    const chat = getChat(CHAT_ID);
    const msgs = readMessages(CHAT_ID, sinceTs ?? 0);
    if (!msgs.length) return text('(no messages)');
    const who = (id: string): string => (id === 'user' ? 'user' : id === HUMAN_ID ? 'you' : id);
    const head = chat?.purpose ? `chat purpose: ${chat.purpose}\n` : '';
    return text(head + msgs.map((m) => `[${who(m.from)}] ${m.text}`).join('\n'));
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch((e) => {
  process.stderr.write(`ateam-chat MCP failed to start: ${String(e)}\n`);
  process.exit(1);
});
