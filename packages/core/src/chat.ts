import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ateamHome } from './paths';

/**
 * Chat mode data layer.
 *
 * "Chat mode" presents work with a teammate (a Human) as a clean chat — the
 * user sees only what the teammate chooses to say (short reports, results,
 * document links), never the raw claude/codex transcript underneath. Each
 * teammate in a chat is backed by a real session; the chat is the tidy view.
 *
 * Two stores, both under `~/.ateam`:
 *   • chats.json                     — the chat list (metadata only)
 *   • chats/<chatId>.jsonl           — that chat's messages, append-only
 * The messages are a JSONL log rather than one big JSON so the desktop and the
 * per-session `ateam-chat` MCP can both append without racing a rewrite; the
 * desktop watches the dir and refreshes live (chat.changed).
 */

export type ChatKind = 'dm' | 'group';

export interface Chat {
  id: string;
  kind: ChatKind;
  /** display name; for a DM it defaults to the teammate's name */
  name: string;
  /** teammate (Human) ids in this chat — never includes the user */
  members: string[];
  /** absolute working directory the teammates act in (docs land here too) */
  workdir: string;
  /** what this chat is for — each teammate reads it to bound their scope */
  purpose?: string;
  createdAt: number;
  /** every WORK session ever spawned for this chat (handoff successors
   *  included), so the chat's token bill can be summed from their
   *  transcripts after a restart — the live session map is memory-only */
  workSessions?: ChatWorkSession[];
}

export interface ChatWorkSession {
  humanId: string;
  cwd: string;
  /** the runtime's own session id (claude --session-id / codex thread) */
  claudeSessionId: string;
  providerId?: string;
}

/** Who a message is from: a teammate's Human id, or the user. */
export type ChatFrom = string | 'user';

export interface ChatAttachment {
  /** shown as the link label */
  name: string;
  /** absolute path under the chat's workdir; opened on click */
  path: string;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  from: ChatFrom;
  /** 'text' a normal message · 'status' a brief progress note · 'result' a
   *  finished deliverable (often with attachments) */
  kind: 'text' | 'status' | 'result';
  text: string;
  attachments?: ChatAttachment[];
  ts: number;
}

interface ChatStore {
  chats: Chat[];
}

function chatsFile(): string {
  return join(ateamHome(), 'chats.json');
}
function chatsDir(): string {
  return join(ateamHome(), 'chats');
}
function chatLogPath(chatId: string): string {
  return join(chatsDir(), `${chatId}.jsonl`);
}

function readStore(): ChatStore {
  try {
    const raw = readFileSync(chatsFile(), 'utf8');
    const j = JSON.parse(raw) as Partial<ChatStore>;
    return { chats: Array.isArray(j.chats) ? j.chats : [] };
  } catch {
    return { chats: [] };
  }
}

function writeStore(s: ChatStore): void {
  const file = chatsFile();
  mkdirSync(ateamHome(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file); // atomic swap so a concurrent reader never sees half
}

export function listChats(): Chat[] {
  // newest first; reverse before the stable sort so that two chats created in
  // the same millisecond order by insertion (the later one is newer)
  return readStore()
    .chats.slice()
    .reverse()
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getChat(id: string): Chat | undefined {
  return readStore().chats.find((c) => c.id === id);
}

export function createChat(args: {
  kind: ChatKind;
  name: string;
  members: string[];
  workdir: string;
  purpose?: string;
}): Chat {
  const chat: Chat = {
    id: randomUUID(),
    kind: args.kind,
    name: args.name.trim() || (args.kind === 'group' ? 'Group' : 'Chat'),
    members: [...new Set(args.members.filter(Boolean))],
    workdir: args.workdir,
    ...(args.purpose?.trim() ? { purpose: args.purpose.trim() } : {}),
    createdAt: Date.now(),
  };
  const s = readStore();
  s.chats.push(chat);
  writeStore(s);
  mkdirSync(chatsDir(), { recursive: true });
  return chat;
}

export function updateChat(
  id: string,
  patch: Partial<Pick<Chat, 'name' | 'members' | 'workdir' | 'purpose'>>,
): Chat | undefined {
  const s = readStore();
  const chat = s.chats.find((c) => c.id === id);
  if (!chat) return undefined;
  if (patch.name !== undefined) chat.name = patch.name;
  if (patch.members !== undefined) chat.members = [...new Set(patch.members.filter(Boolean))];
  if (patch.workdir !== undefined) chat.workdir = patch.workdir;
  if (patch.purpose !== undefined) chat.purpose = patch.purpose.trim() || undefined;
  writeStore(s);
  return chat;
}

/** Remember a work session spawned for a chat (idempotent on the id). */
export function recordChatWorkSession(chatId: string, rec: ChatWorkSession): void {
  const s = readStore();
  const chat = s.chats.find((c) => c.id === chatId);
  if (!chat) return;
  const list = chat.workSessions ?? [];
  if (list.some((w) => w.claudeSessionId === rec.claudeSessionId)) return;
  chat.workSessions = [...list, rec];
  writeStore(s);
}

export function deleteChat(id: string): void {
  const s = readStore();
  const next = s.chats.filter((c) => c.id !== id);
  if (next.length === s.chats.length) return;
  writeStore({ chats: next });
  // leave the message log on disk; the user asked to keep all chat records
}

export function appendMessage(msg: {
  chatId: string;
  from: ChatFrom;
  kind?: ChatMessage['kind'];
  text: string;
  attachments?: ChatAttachment[];
}): ChatMessage {
  const full: ChatMessage = {
    id: randomUUID(),
    chatId: msg.chatId,
    from: msg.from,
    kind: msg.kind ?? 'text',
    text: msg.text,
    ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
    ts: Date.now(),
  };
  mkdirSync(chatsDir(), { recursive: true });
  appendFileSync(chatLogPath(msg.chatId), `${JSON.stringify(full)}\n`);
  return full;
}

/** Read a chat's messages in order. `sinceTs` (exclusive) returns only newer
 *  ones — how the MCP polls for what the user said without re-reading all. */
export function readMessages(chatId: string, sinceTs = 0): ChatMessage[] {
  const path = chatLogPath(chatId);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: ChatMessage[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as ChatMessage;
      if (m.ts > sinceTs) out.push(m);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/** Every chat that has a message log on disk — used to watch the dir. */
export function chatLogDir(): string {
  return chatsDir();
}

/** Chats a given teammate belongs to (for their autonomous behaviour later). */
export function chatsForHuman(humanId: string): Chat[] {
  return listChats().filter((c) => c.members.includes(humanId));
}

/**
 * The system-prompt briefing for a teammate's WORK session in a chat.
 *
 * In chat mode a teammate is one Human wearing two sessions: the chat side
 * (a one-shot in chat-responder.ts that talks to the user and takes the
 * floor in turn) and this work side — the long-running hidden session that
 * receives tasks from its chat side and does them. The user never sees this
 * terminal; the only things that reach the chat are what this session posts
 * through the ateam-chat tools, so it speaks sparingly: a milestone, a
 * result, a document link. Conversation is the chat side's job.
 */
export function chatFramingPrompt(
  chat: Pick<Chat, 'name' | 'purpose' | 'workdir'>,
  who: { name: string; role: string },
  /** the OTHER teammates in this chat (empty for a DM) — so a group member
   *  knows who else is here and whose part is whose */
  peers: { name: string; role: string }[] = [],
): string {
  const where = chat.workdir
    ? `Your working directory is ${chat.workdir}.`
    : 'You have no fixed project directory; work in your own desk directory and cd into projects as needed.';
  const scope = chat.purpose
    ? ` This chat is for: ${chat.purpose}. Keep what you do within that scope.`
    : '';
  const lines = [
    `You are ${who.name}, a ${who.role} on this team — the WORK side of yourself for the chat "${chat.name}".${scope}`,
    'The conversation with the user is handled by your chat side (a separate short session of you). It hands you tasks here as messages; you do them. The user sees ONLY what is posted to the chat with the ateam-chat tools — never this terminal or your work. So:',
    '- Do the real work here; spawn sub-agents when it helps, and keep track of them.',
    "- Post to the chat sparingly: chat_say kind:'status' at a real milestone, kind:'result' when the task is done. Never paste long output, logs, or code into the chat.",
    '- Write it for someone reading on a phone: one plain line saying what is done, then AT MOST 4 bullet lines starting with "- ", one fact each, under ~12 words. Never a dense paragraph, never an exhaustive list of every change — mention what the user asked about and leave the rest to the files.',
    `- Deliver any document with chat_attach: write the file (under your working directory), then send its path as a link — never paste the contents. ${where}`,
    '- chat_read shows the whole conversation (what the user asked, what teammates said, the agreed split). Read it when a task is ambiguous; do not answer questions or chit-chat there — your chat side does that. Report only on your work.',
  ];
  if (peers.length > 0) {
    const roster = peers.map((p) => `${p.name} (${p.role})`).join(', ');
    lines.push(
      `This is a GROUP with your teammates: ${roster}. The split of work was agreed in the chat: do ONLY the part given to you, never redo or duplicate a teammate's part. Use chat_say with a teammate only for a real hand-off or blocker, not to acknowledge.`,
    );
  }
  lines.push('Be concise and to the point, like a busy colleague.');
  return lines.join('\n');
}

export { chatsFile as chatsStoreFile };
