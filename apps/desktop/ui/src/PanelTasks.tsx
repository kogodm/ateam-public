import type { SessionNode, TaskDTO } from '@ateam/contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fillComposer } from './composerRegistry';
import type { Rpc } from './rpc';

const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p;

/** compact reminder label: HH:MM today, else MM-DD HH:MM */
function fmtRemind(ms: number): string {
  const d = new Date(ms);
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return `today ${hh}:${mm}`;
  return `${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')} ${hh}:${mm}`;
}

/** MM-DD for a created-at fallback line. */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/** Deterministic chip colors from a tag's text (same tag → same color, dark-
 *  theme friendly). Hash → hue; fixed sat/lightness for legible contrast. */
function tagColor(tag: string): { background: string; color: string; borderColor: string } {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return {
    background: `hsl(${hue} 45% 20% / 0.85)`,
    color: `hsl(${hue} 75% 80%)`,
    borderColor: `hsl(${hue} 40% 42%)`,
  };
}

/** Render a task's tags as colored chips (nothing when empty). */
function TagChips({ tags }: { tags?: string[] }): JSX.Element | null {
  if (!tags?.length) return null;
  return (
    <>
      {tags.map((tag) => (
        <span key={tag} className="task-tag" style={tagColor(tag)}>
          {tag}
        </span>
      ))}
    </>
  );
}

/** split a free-text tag input on commas / whitespace. */
function parseTags(s: string): string[] {
  return s
    .split(/[\s,，、]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 3);
}

/**
 * Task list / reminders. Scoped to the focused session's project by default
 * (agents add tasks through the `ateam-tasks` MCP, auto-scoped to their cwd),
 * with a "全部" toggle for the cross-project view. Rows show ONLY the title;
 * the carried `body` is hidden and delivered to the focused session — verbatim
 * — on the one-click send (▶). Live-refreshes on `task.changed` (desktop OR
 * agent writes) and on `task.due`.
 */
export function TasksPane({
  rpc,
  session,
  onJumpSession,
}: {
  rpc: Rpc;
  session: SessionNode | undefined;
  /** jump to the session that filed this task (only offered when the task
   *  recorded a claudeSessionId at creation). */
  onJumpSession?: (t: TaskDTO) => void;
}): JSX.Element {
  const cwd = session?.cwd ?? '';
  const [scopeAll, setScopeAll] = useState(false);
  const [tasks, setTasks] = useState<TaskDTO[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [remind, setRemind] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [note, setNote] = useState('');
  const [detail, setDetail] = useState<TaskDTO | null>(null);
  const [showDone, setShowDone] = useState(false);

  // seq guard: overlapping task.list responses can land out of order (rapid
  // task.changed bursts); only the latest request may apply its snapshot —
  // same fix as the tree-badge loader in App.tsx.
  const loadSeqRef = useRef(0);
  const load = useCallback(() => {
    const params = scopeAll ? {} : { project: cwd };
    const mine = ++loadSeqRef.current;
    void rpc
      .request('task.list', params)
      .then((r) => {
        if (mine === loadSeqRef.current) setTasks(r.tasks);
      })
      .catch(() => {});
  }, [rpc, scopeAll, cwd]);

  useEffect(() => {
    load();
  }, [load]);
  // live refresh: any store mutation (desktop or an agent's MCP call) + due fires
  useEffect(() => rpc.on('task.changed', () => load()), [rpc, load]);
  useEffect(() => rpc.on('task.due', () => load()), [rpc, load]);
  // Esc closes whichever popup is open
  useEffect(() => {
    if (!detail && !addOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setDetail(null);
        setAddOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail, addOpen]);

  const openAdd = useCallback(() => {
    setTitle('');
    setBody('');
    setRemind('');
    setTagInput('');
    setNote('');
    setAddOpen(true);
  }, []);

  const add = useCallback(() => {
    const t = title.trim();
    if (!t) return;
    const parsed = remind ? Date.parse(remind) : Number.NaN;
    const remindAt = Number.isNaN(parsed) ? undefined : parsed;
    const tags = parseTags(tagInput);
    void rpc
      .request('task.add', {
        title: t,
        body: body.trim() || undefined,
        project: cwd,
        remindAt,
        tags: tags.length ? tags : undefined,
      })
      .then(() => {
        setAddOpen(false);
        setNote('');
        load();
      })
      .catch((e) => setNote(`Add failed: ${e instanceof Error ? e.message : String(e)}`));
  }, [rpc, title, body, remind, tagInput, cwd, load]);

  const toggleDone = useCallback(
    (t: TaskDTO) => {
      void rpc
        .request(t.status === 'done' ? 'task.reopen' : 'task.complete', { id: t.id })
        .then(load)
        .catch(() => {});
    },
    [rpc, load],
  );

  const remove = useCallback(
    (id: string) => {
      void rpc.request('task.remove', { id }).then(load).catch(() => {});
    },
    [rpc, load],
  );

  // one-click send: deliver the carried body (or the title if none) into the
  // focused session's PTY. Not auto-submitted — it lands in claude's input for
  // a glance before Enter.
  const send = useCallback(
    (t: TaskDTO) => {
      if (!session?.sessionId) {
        setNote('Focus a session first, then send');
        return;
      }
      const data = t.body?.trim() || t.title;
      // stream mode's composer is a React textarea, not the PTY — see
      // composerRegistry. Sending to the terminal there puts the task
      // somewhere the reader cannot see it.
      if (fillComposer(session.sessionId, data)) {
        setNote(`Sent to session: ${t.title}`);
        return;
      }
      void rpc
        .request('session.input', { sessionId: session.sessionId, data })
        .then(() => setNote(`Sent to session: ${t.title}`))
        .catch((e) => setNote(`Send failed: ${e instanceof Error ? e.message : String(e)}`));
    },
    [rpc, session],
  );

  const now = Date.now();
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const visible = showDone ? tasks : tasks.filter((t) => t.status === 'open');
  return (
    <div className="tasks-pane">
      <div className="tasks-scope">
        <button
          type="button"
          className={scopeAll ? '' : 'on'}
          onClick={() => setScopeAll(false)}
          title="Only this project's tasks"
        >
          This project
        </button>
        <button
          type="button"
          className={scopeAll ? 'on' : ''}
          onClick={() => setScopeAll(true)}
          title="All tasks across projects"
        >
          All
        </button>
        <button
          type="button"
          className={`tasks-done-toggle${showDone ? ' on' : ''}`}
          onClick={() => setShowDone((v) => !v)}
          title={showDone ? 'Hide completed tasks' : 'Show completed tasks'}
        >
          Done{doneCount ? ` ${doneCount}` : ''}
        </button>
        <button type="button" className="tasks-add-open" onClick={openAdd} title="New task">
          ＋
        </button>
      </div>

      {note && <div className="tasks-note muted small">{note}</div>}

      {addOpen && (
        <div className="task-modal-backdrop" onClick={() => setAddOpen(false)}>
          <div className="task-modal" onClick={(e) => e.stopPropagation()}>
            <div className="task-modal-head">
              <span className="task-modal-title">New task</span>
              <button
                type="button"
                className="task-modal-close"
                title="Close (Esc)"
                onClick={() => setAddOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="task-form">
              <label className="task-form-label">Title</label>
              {/* biome-ignore lint/a11y/noAutofocus: focus the first field when the dialog opens */}
              <input
                className="task-form-input"
                placeholder="Task title…"
                value={title}
                autoFocus
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    add();
                  }
                }}
              />
              <label className="task-form-label">Body (optional — what gets sent to the session)</label>
              <textarea
                className="task-form-textarea"
                placeholder="Paths / commands / notes…"
                value={body}
                rows={3}
                onChange={(e) => setBody(e.target.value)}
              />
              <label className="task-form-label">Tags (space/comma separated, up to 3)</label>
              <input
                className="task-form-input"
                placeholder="e.g. project P0 bug"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
              />
              {tagInput.trim() && (
                <div className="tasks-tag-preview">
                  <TagChips tags={parseTags(tagInput)} />
                </div>
              )}
              <label className="task-form-label">Reminder (optional)</label>
              <input
                type="datetime-local"
                className="task-form-input"
                value={remind}
                onChange={(e) => setRemind(e.target.value)}
              />
            </div>
            <div className="task-modal-foot">
              <button
                type="button"
                className="task-modal-btn primary"
                onClick={add}
                disabled={!title.trim()}
              >
                Add
              </button>
              <button type="button" className="task-modal-btn" onClick={() => setAddOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="muted small tasks-empty">
          {tasks.length && !showDone ? 'No open tasks' : 'No tasks yet'}
        </div>
      ) : (
        <div className="tasks-list">
          {visible.map((t) => {
            const overdue = t.status === 'open' && t.remindAt !== undefined && t.remindAt <= now;
            return (
              <div
                key={t.id}
                className={`task-row${t.status === 'done' ? ' done' : ''}${overdue ? ' due' : ''}`}
                onClick={() => setDetail(t)}
                title="Click for details"
              >
                <input
                  type="checkbox"
                  className="task-check"
                  checked={t.status === 'done'}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleDone(t)}
                  title={t.status === 'done' ? 'Mark as open' : 'Mark as done'}
                />
                <div className="task-main">
                  <div className="task-title" title={t.title}>
                    {t.title}
                  </div>
                  <div className="task-meta">
                    {t.remindAt !== undefined ? (
                      <span className="task-remind" title={new Date(t.remindAt).toLocaleString()}>
                        <span className="task-remind-ic">◷</span> {fmtRemind(t.remindAt)}
                      </span>
                    ) : (
                      <span className="task-created">added {fmtDate(t.createdAt)}</span>
                    )}
                    {scopeAll && t.project && (
                      <span className="task-proj">{baseName(t.project)}</span>
                    )}
                    <TagChips tags={t.tags} />
                  </div>
                </div>
                <div className="task-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="task-send"
                    title="Send to the focused session"
                    onClick={() => send(t)}
                  >
                    ▶
                  </button>
                  <button
                    type="button"
                    className="task-del"
                    title="Delete task"
                    onClick={() => remove(t.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {detail && (
        <div className="task-modal-backdrop" onClick={() => setDetail(null)}>
          <div className="task-modal" onClick={(e) => e.stopPropagation()}>
            <div className="task-modal-head">
              <span className="task-modal-title">{detail.title}</span>
              <button
                type="button"
                className="task-modal-close"
                title="Close (Esc)"
                onClick={() => setDetail(null)}
              >
                ✕
              </button>
            </div>
            <div className="task-modal-meta">
              <span className={`task-modal-badge${detail.status === 'done' ? ' done' : ''}`}>
                {detail.status === 'done' ? 'Done' : 'Open'}
              </span>
              {detail.remindAt !== undefined && (
                <span className="task-modal-badge remind">
                  ◷ {new Date(detail.remindAt).toLocaleString()}
                </span>
              )}
              <span className="task-modal-badge">
                {detail.source === 'agent' ? 'Agent' : 'Manual'}
              </span>
            </div>
            {detail.tags?.length ? (
              <div className="task-modal-tags">
                <TagChips tags={detail.tags} />
              </div>
            ) : null}
            {detail.project && (
              <div className="task-modal-line mono" title={detail.project}>
                {detail.project}
              </div>
            )}
            <div className="task-modal-line muted small">
              Added {new Date(detail.createdAt).toLocaleString()}
              {detail.doneAt ? ` · done ${new Date(detail.doneAt).toLocaleString()}` : ''}
            </div>
            {detail.claudeSessionId && (
              <div className="task-modal-line muted small">
                Origin session {detail.claudeSessionId.slice(0, 8)}…
              </div>
            )}
            {detail.body ? (
              <div className="task-modal-field">
                <div className="task-modal-label">Body (the text sent to the session)</div>
                <pre className="task-modal-pre">{detail.body}</pre>
              </div>
            ) : (
              <div className="task-modal-line muted small">(no body — the title is sent instead)</div>
            )}
            <div className="task-modal-foot">
              <button type="button" className="task-modal-btn primary" onClick={() => send(detail)}>
                ▶ Send to session
              </button>
              {detail.claudeSessionId && onJumpSession && (
                <button
                  type="button"
                  className="task-modal-btn"
                  title="Jump to the session that created this task (follows handoffs to the newest successor)"
                  onClick={() => {
                    onJumpSession(detail);
                    setDetail(null);
                  }}
                >
                  ↗ Origin session
                </button>
              )}
              <button
                type="button"
                className="task-modal-btn"
                onClick={() => {
                  toggleDone(detail);
                  setDetail(null);
                }}
              >
                {detail.status === 'done' ? 'Mark as open' : 'Mark as done'}
              </button>
              <button
                type="button"
                className="task-modal-btn danger"
                onClick={() => {
                  remove(detail.id);
                  setDetail(null);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
