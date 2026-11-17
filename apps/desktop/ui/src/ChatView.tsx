import type { ChatDTO, ChatMessageDTO, ChatUsageBucket, HumanDTO } from '@ateam/contract';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DirPicker } from './DirPicker';
import { avatarSrc } from './avatars';
import { useImeGuard } from './imeGuard';
import type { Rpc } from './rpc';

/**
 * Chat mode — the end-state surface where the user does NOT manage sessions,
 * only talks to teammates. A full-screen IM client, isolated from the
 * project/session view: a chat list on the left, a message thread on the
 * right. Everything under it (spawning the teammate's session, its handoffs
 * and sub-agents) stays hidden; the user sees only what a teammate says.
 */
interface Props {
  rpc: Rpc;
  humans: HumanDTO[];
  recent: { dir: string; source: string }[];
  onClose: () => void;
  /** open a delivered document (a chat_attach link) */
  onOpenPath: (path: string) => void;
  /** re-read the teammate list after an edit here (e.g. a model change) */
  onHumansChanged: () => void;
}

type Draft =
  | { open: false }
  | { open: true; kind: 'dm'; humanId: string }
  | {
      open: true;
      kind: 'group';
      name: string;
      members: string[];
      workdir: string;
      purpose: string;
    };

/**
 * What a teammate's model tag can be set to. The value is passed to the CLI
 * verbatim (`claude --model` / `codex -m`), so an alias tracks that family's
 * latest release instead of pinning a dated id. '' = whatever the runtime
 * itself defaults to (the user's own CLI settings).
 */
const MODEL_CHOICES: { value: string; label: string; hint: string }[] = [
  { value: '', label: 'Default', hint: "the runtime's own setting" },
  { value: 'fable', label: 'Fable', hint: 'most capable · priciest' },
  { value: 'opus', label: 'Opus', hint: 'strong · half of Fable' },
  { value: 'sonnet', label: 'Sonnet', hint: 'fast · a fifth of Fable' },
  { value: 'haiku', label: 'Haiku', hint: 'cheapest · simple work' },
];

/** Short label for a bound model — an alias as-is, a full id trimmed to its
 *  family so `claude-fable-5-1` reads as "fable 5 1"'s first word. */
function modelLabel(model?: string): string {
  if (!model) return 'default';
  const known = MODEL_CHOICES.find((c) => c.value && c.value === model.toLowerCase());
  if (known) return known.label.toLowerCase();
  return model.replace(/^claude-/, '').replace(/-\d.*$/, '');
}

/**
 * Render a message as lines, with leading "- " / "• " / "1." turned into
 * indented rows. Teammates are asked to write one line plus a few bullets;
 * this makes that shape readable instead of one grey slab of text.
 */
function MessageBody({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((raw, i) => {
        const line = raw.trimEnd();
        const m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
        const key = `${i}-${line.slice(0, 24)}`;
        if (m) {
          return (
            <span className="chat-li" key={key}>
              <span className="chat-li-dot" aria-hidden>
                •
              </span>
              <span>{m[1]}</span>
            </span>
          );
        }
        if (!line.trim()) return <span className="chat-gap" key={key} />;
        return (
          <span className="chat-p" key={key}>
            {line}
          </span>
        );
      })}
    </>
  );
}

/** every billed token of one side, all four buckets */
function bucketSum(b: ChatUsageBucket): number {
  return b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheCreationTokens;
}
function fmtUsd(n: number): string {
  return n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export function ChatView({
  rpc,
  humans,
  recent,
  onClose,
  onOpenPath,
  onHumansChanged,
}: Props): JSX.Element {
  const [chats, setChats] = useState<ChatDTO[]>([]);
  const [sel, setSel] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Draft>({ open: false });
  // the teammate holding the floor (composing a reply), from chat.messages
  const [typing, setTyping] = useState<string | null>(null);
  // an IME's commit-Enter must never send the half-typed message
  const ime = useImeGuard();
  // the member whose model tag is open for editing, and where to draw its
  // menu. The roster is a horizontally scrolling strip, so a menu positioned
  // inside it is clipped away — it renders in a portal at a fixed point.
  const [modelFor, setModelFor] = useState<{ humanId: string; top: number; left: number } | null>(
    null,
  );
  // what the selected chat has cost so far (chat-side replies + work sessions)
  const [usage, setUsage] = useState<{
    total: number;
    costUsd: number;
    chat: ChatUsageBucket;
    work: ChatUsageBucket;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const humanById = useMemo(() => new Map(humans.map((h) => [h.id, h])), [humans]);
  const selChat = chats.find((c) => c.id === sel);

  const loadChats = useCallback(() => {
    void rpc.request('chat.list', {}).then((r) => setChats(r.chats));
  }, [rpc]);
  const loadMessages = useCallback(
    (chatId: string) => {
      void rpc.request('chat.messages', { chatId }).then((r) => {
        setMessages(r.messages);
        setTyping(r.typing);
      });
    },
    [rpc],
  );

  // The bill sums whole transcripts, so refresh it at most every few seconds
  // while things change, not on every event.
  const usageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadUsage = useCallback(
    (chatId: string) => {
      if (usageTimer.current) return;
      usageTimer.current = setTimeout(() => {
        usageTimer.current = null;
        void rpc.request('chat.usage', { chatId }).then(setUsage);
      }, 3000);
    },
    [rpc],
  );

  // first load + live refresh
  useEffect(() => loadChats(), [loadChats]);
  useEffect(() => {
    return rpc.on('chat.changed', (d) => {
      loadChats();
      const changed = (d as { chatId?: string }).chatId;
      if (sel && (!changed || changed === sel)) {
        loadMessages(sel);
        loadUsage(sel);
      }
    });
  }, [rpc, sel, loadChats, loadMessages, loadUsage]);
  // load the thread when the selection changes
  useEffect(() => {
    setUsage(null);
    if (sel) {
      loadMessages(sel);
      void rpc.request('chat.usage', { chatId: sel }).then(setUsage);
    } else {
      setMessages([]);
      setTyping(null);
    }
  }, [sel, rpc, loadMessages]);
  // keep pinned to the newest message
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typing]);

  useEffect(() => {
    if (!modelFor) return;
    const close = (): void => setModelFor(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    // capture: the menu's own buttons call setModel before this fires
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [modelFor]);

  const setModel = useCallback(
    (humanId: string, model: string) => {
      setModelFor(null);
      void rpc.request('human.update', { id: humanId, patch: { model } }).then(onHumansChanged);
    },
    [rpc, onHumansChanged],
  );

  const send = useCallback(() => {
    const body = text.trim();
    if (!body || !sel) return;
    setText('');
    void rpc.request('chat.send', { chatId: sel, text: body }).then(() => loadMessages(sel));
  }, [text, sel, rpc, loadMessages]);

  const createDm = useCallback(
    (h: HumanDTO) => {
      void rpc.request('chat.create', { kind: 'dm', name: h.name, members: [h.id] }).then((r) => {
        setDraft({ open: false });
        setChats((cs) => [r.chat, ...cs.filter((c) => c.id !== r.chat.id)]);
        setSel(r.chat.id);
      });
    },
    [rpc],
  );
  const createGroup = useCallback(
    (name: string, members: string[], workdir: string, purpose: string) => {
      void rpc
        .request('chat.create', { kind: 'group', name, members, workdir, purpose })
        .then((r) => {
          setDraft({ open: false });
          setChats((cs) => [r.chat, ...cs.filter((c) => c.id !== r.chat.id)]);
          setSel(r.chat.id);
        });
    },
    [rpc],
  );

  return (
    <div className="chat-mode">
      <div className="chat-list">
        <div className="chat-list-head">
          <span className="chat-list-title">Team</span>
          <button
            type="button"
            className="chat-new"
            title="New chat"
            onClick={() => setDraft({ open: true, kind: 'dm', humanId: humans[0]?.id ?? '' })}
          >
            ＋
          </button>
          <button type="button" className="chat-close" title="Close chat mode" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="chat-list-body">
          {chats.length === 0 && <div className="chat-empty">No chats yet. ＋ to start one.</div>}
          {chats.map((c) => {
            const dmHuman = c.kind === 'dm' ? humanById.get(c.members[0] ?? '') : undefined;
            return (
              <button
                type="button"
                key={c.id}
                className={`chat-row${c.id === sel ? ' on' : ''}`}
                onClick={() => setSel(c.id)}
              >
                {c.kind === 'dm' ? (
                  <img className="chat-ava" src={avatarSrc(dmHuman?.avatarId)} alt="" />
                ) : (
                  <span className="chat-ava chat-ava-group">#</span>
                )}
                <span className="chat-row-body">
                  <span className="chat-row-name">{c.name}</span>
                  <span className="chat-row-sub">
                    {c.kind === 'group'
                      ? `${c.members.length} members${c.workdir ? '' : ' · no dir'}`
                      : (dmHuman?.role ?? 'teammate')}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="chat-thread">
        {!selChat ? (
          <div className="chat-thread-empty">Pick a chat, or start a new one.</div>
        ) : (
          <>
            <div className="chat-thread-head">
              <div className="chat-thread-head-main">
                <span className="chat-thread-title">
                  {selChat.name}
                  {selChat.kind === 'group' && (
                    <span className="chat-thread-count">{selChat.members.length}</span>
                  )}
                </span>
                <span className="chat-thread-sub">
                  {selChat.kind === 'group'
                    ? selChat.workdir || 'no directory'
                    : (humanById.get(selChat.members[0] ?? '')?.role ?? '')}
                </span>
              </div>
              {usage && (
                <div
                  className="chat-usage"
                  title={[
                    'What this chat has billed, at list price per model',
                    `replies: ${fmtUsd(usage.chat.costUsd)} · ${fmtTokens(bucketSum(usage.chat))} tokens (${usage.chat.calls} calls)`,
                    `work: ${fmtUsd(usage.work.costUsd)} · ${fmtTokens(bucketSum(usage.work))} tokens (${usage.work.calls} turns)`,
                    `input ${fmtTokens(usage.chat.inputTokens + usage.work.inputTokens)} · output ${fmtTokens(usage.chat.outputTokens + usage.work.outputTokens)} · cache write ${fmtTokens(usage.chat.cacheCreationTokens + usage.work.cacheCreationTokens)} · cache read ${fmtTokens(usage.chat.cacheReadTokens + usage.work.cacheReadTokens)}`,
                  ].join('\n')}
                >
                  <span className="chat-usage-num">{fmtUsd(usage.costUsd)}</span>
                  <span className="chat-usage-label">{fmtTokens(usage.total)} tokens</span>
                </div>
              )}
            </div>
            {selChat.kind === 'group' && (
              <div className="chat-members" title="Group members">
                {selChat.members.map((m) => {
                  const h = humanById.get(m);
                  return (
                    <span className="chat-member" key={m} title={h?.role ?? ''}>
                      <img className="chat-member-ava" src={avatarSrc(h?.avatarId)} alt="" />
                      <span className="chat-member-name">{h?.name ?? m}</span>
                      <button
                        type="button"
                        className={`chat-member-model${h?.model ? ' set' : ''}`}
                        title={`Model for ${h?.name ?? m} — applies to every session they run`}
                        onClick={(e) => {
                          if (modelFor?.humanId === m) {
                            setModelFor(null);
                            return;
                          }
                          const r = e.currentTarget.getBoundingClientRect();
                          setModelFor({ humanId: m, top: r.bottom + 6, left: r.left });
                        }}
                      >
                        {modelLabel(h?.model)}
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            {modelFor &&
              createPortal(
                <div
                  className="chat-model-menu"
                  style={{ top: modelFor.top, left: modelFor.left }}
                  // the document-level closer runs on mousedown; keep a click
                  // inside the menu from dismissing it before it lands
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {MODEL_CHOICES.map((c) => {
                    const cur = humanById.get(modelFor.humanId)?.model ?? '';
                    return (
                      <button
                        type="button"
                        key={c.value || 'default'}
                        className={`chat-model-opt${cur === c.value ? ' on' : ''}`}
                        onClick={() => setModel(modelFor.humanId, c.value)}
                      >
                        <span className="chat-model-opt-name">{c.label}</span>
                        <span className="chat-model-opt-hint">{c.hint}</span>
                      </button>
                    );
                  })}
                </div>,
                document.body,
              )}
            <div className="chat-msgs" ref={scrollRef}>
              {messages.map((m) => {
                const mine = m.from === 'user';
                const h = mine ? undefined : humanById.get(m.from);
                return (
                  <div key={m.id} className={`chat-msg${mine ? ' mine' : ''}`}>
                    {!mine && <img className="chat-msg-ava" src={avatarSrc(h?.avatarId)} alt="" />}
                    <div className="chat-msg-col">
                      {!mine && selChat.kind === 'group' && (
                        <span className="chat-msg-who">{h?.name ?? m.from}</span>
                      )}
                      <div className={`chat-bubble${m.kind === 'status' ? ' status' : ''}`}>
                        <MessageBody text={m.text} />
                        {m.attachments?.map((a) => (
                          <button
                            type="button"
                            key={a.path}
                            className="chat-attach"
                            onClick={() => onOpenPath(a.path)}
                            title={a.path}
                          >
                            📄 {a.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
              {typing && (
                <div className="chat-msg chat-typing-row" key="typing">
                  <img
                    className="chat-msg-ava"
                    src={avatarSrc(humanById.get(typing)?.avatarId)}
                    alt=""
                  />
                  <div className="chat-msg-col">
                    {selChat.kind === 'group' && (
                      <span className="chat-msg-who">{humanById.get(typing)?.name ?? typing}</span>
                    )}
                    <div className="chat-bubble chat-typing" aria-label="typing">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="chat-compose">
              <textarea
                className="chat-input"
                value={text}
                placeholder={`Message ${selChat.name}…`}
                rows={1}
                onChange={(e) => setText(e.target.value)}
                {...ime.imeProps}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !ime.isImeCommit(e)) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button type="button" className="chat-send" onClick={send} disabled={!text.trim()}>
                Send
              </button>
            </div>
          </>
        )}
      </div>

      {draft.open && (
        <NewChat
          draft={draft}
          humans={humans}
          recent={recent}
          onCancel={() => setDraft({ open: false })}
          onDm={createDm}
          onGroup={createGroup}
          setDraft={setDraft}
        />
      )}
    </div>
  );
}

function NewChat({
  draft,
  humans,
  recent,
  onCancel,
  onDm,
  onGroup,
  setDraft,
}: {
  draft: Extract<Draft, { open: true }>;
  humans: HumanDTO[];
  recent: { dir: string; source: string }[];
  onCancel: () => void;
  onDm: (h: HumanDTO) => void;
  onGroup: (name: string, members: string[], workdir: string, purpose: string) => void;
  setDraft: (d: Draft) => void;
}): JSX.Element {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-dismiss; Esc-to-close is a mouse-parity nicety, not the only path
    <div className="chat-modal-bg" onClick={onCancel}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops backdrop dismiss from firing on inner clicks */}
      <div className="chat-modal" onClick={(e) => e.stopPropagation()}>
        <div className="chat-modal-tabs">
          <button
            type="button"
            className={draft.kind === 'dm' ? 'on' : ''}
            onClick={() => setDraft({ open: true, kind: 'dm', humanId: humans[0]?.id ?? '' })}
          >
            Direct
          </button>
          <button
            type="button"
            className={draft.kind === 'group' ? 'on' : ''}
            onClick={() =>
              setDraft({
                open: true,
                kind: 'group',
                name: '',
                members: [],
                workdir: '',
                purpose: '',
              })
            }
          >
            Group
          </button>
        </div>

        {draft.kind === 'dm' ? (
          <div className="chat-modal-body">
            <div className="chat-modal-label">Chat with</div>
            <div className="chat-pick-list">
              {humans.map((h) => (
                <button type="button" key={h.id} className="chat-pick" onClick={() => onDm(h)}>
                  <img className="chat-ava" src={avatarSrc(h.avatarId)} alt="" />
                  <span className="chat-row-body">
                    <span className="chat-row-name">{h.name}</span>
                    <span className="chat-row-sub">{h.role}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat-modal-body">
            <div className="chat-modal-label">Group name</div>
            <input
              className="chat-field"
              value={draft.name}
              placeholder="e.g. Backend"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <div className="chat-modal-label">Working directory</div>
            <DirPicker
              value={draft.workdir}
              recent={recent}
              onChange={(dir) => setDraft({ ...draft, workdir: dir })}
              noneLabel="— no directory —"
            />
            <div className="chat-modal-label">What is this group for?</div>
            <textarea
              className="chat-field"
              value={draft.purpose}
              placeholder="Each teammate reads this to bound their scope."
              rows={2}
              onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
            />
            <div className="chat-modal-label">Members</div>
            <div className="chat-pick-list">
              {humans.map((h) => {
                const on = draft.members.includes(h.id);
                return (
                  <button
                    type="button"
                    key={h.id}
                    className={`chat-pick${on ? ' on' : ''}`}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        members: on
                          ? draft.members.filter((m) => m !== h.id)
                          : [...draft.members, h.id],
                      })
                    }
                  >
                    <img className="chat-ava" src={avatarSrc(h.avatarId)} alt="" />
                    <span className="chat-row-body">
                      <span className="chat-row-name">{h.name}</span>
                      <span className="chat-row-sub">{h.role}</span>
                    </span>
                    {on && <span className="chat-pick-check">✓</span>}
                  </button>
                );
              })}
            </div>
            <div className="chat-modal-foot">
              <button
                type="button"
                className="chat-send"
                disabled={!draft.name.trim() || draft.members.length === 0}
                onClick={() =>
                  onGroup(draft.name.trim(), draft.members, draft.workdir, draft.purpose.trim())
                }
              >
                Create group
              </button>
              <button type="button" className="chat-cancel" onClick={onCancel}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
