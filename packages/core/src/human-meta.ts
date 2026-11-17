import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getHuman } from './humans';
import { ateamHome } from './paths';
import { getPrompt } from './prompts';

/**
 * Per-human knowledge index ("meta.md") + its content tree.
 *
 * Replaces the old recall surface (AssetStore INDEX.md 总纲 + top-N
 * experience injection + periodic distill). The new model:
 *
 *   ~/.ateam/users/local/agents/<humanId>/meta/
 *     meta.md                     ← the INDEX (recall surface): brief
 *                                   one-line summaries + a relative path
 *                                   per entry. This is the ONLY thing
 *                                   injected at spawn.
 *     skills/<slug>/SKILL.md      ← full skill, written /skill-create style
 *     knowledge/<slug>.md         ← full knowledge note
 *     experiences/<slug>.md       ← full experience write-up
 *
 * The files are authored/updated BY the handoff session itself (it already
 * has the whole conversation in context — no separate LLM call, no token
 * blow-up from re-feeding the transcript). At the next spawn (post-handoff
 * or a fresh human session) recall injects meta.md and tells the model to
 * read a referenced file only when the task relates to it.
 */

/** `<root>/users/local/agents/<humanId>/meta`. Keyed by humanId (the same
 *  agentKey the vault + recall use). */
export function humanMetaDir(humanId: string): string {
  return join(ateamHome(), 'users', 'local', 'agents', humanId, 'meta');
}

export function humanMetaPath(humanId: string): string {
  return join(humanMetaDir(humanId), 'meta.md');
}

/** Create the meta dir (+ the three content subdirs) so the handoff session
 *  can write into a known layout. Idempotent. Returns the meta dir path. */
export function ensureHumanMetaDir(humanId: string): string {
  const dir = humanMetaDir(humanId);
  for (const sub of ['skills', 'knowledge', 'experiences']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

/** The meta.md content for recall injection. '' when the human has no
 *  index yet (never handed off) — recall then simply omits the section. */
export function readHumanMeta(humanId: string): string {
  const p = humanMetaPath(humanId);
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

export interface HumanMetaEntry {
  kind: 'skill' | 'knowledge' | 'experience';
  name: string;
  /** absolute path of the entry's markdown file — the UI previews it with
   *  `file.read`, so the path is resolved HERE (a skill's entry file is not
   *  always SKILL.md) instead of being reconstructed client-side. */
  path: string;
}

export interface HumanMetaEntries {
  /** meta.md itself (the index) — '' when never written */
  index: string;
  /** absolute path of meta.md (may not exist yet) */
  indexPath: string;
  entries: HumanMetaEntry[];
}

/** Candidate entry filenames inside a skill directory, best first. */
const SKILL_ENTRY_FILES = ['SKILL.md', 'skill.md', 'README.md', 'readme.md'];

/** List the human's meta content tree. `skills/` holds a directory per skill
 *  (`<slug>/SKILL.md`); `knowledge/` and `experiences/` hold flat `.md` notes.
 *  Everything is best-effort: a missing dir is an empty list, never a throw.
 *
 *  This is the LIVE memory system. Anything that reports "what has this human
 *  accumulated" must read HERE — the old AssetStore experience DB is frozen
 *  and reports zero for every human whose knowledge was written after the
 *  switch. */
export function readHumanMetaEntries(humanId: string): HumanMetaEntries {
  const dir = humanMetaDir(humanId);
  const entries: HumanMetaEntry[] = [];
  const read = (sub: string): { name: string; isDir: boolean }[] => {
    try {
      return readdirSync(join(dir, sub), { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  };
  for (const e of read('skills')) {
    if (!e.isDir) continue;
    const skillDir = join(dir, 'skills', e.name);
    const file = SKILL_ENTRY_FILES.find((f) => existsSync(join(skillDir, f)));
    if (!file) continue; // a directory with no readable entry doc isn't a skill
    entries.push({ kind: 'skill', name: e.name, path: join(skillDir, file) });
  }
  for (const [sub, kind] of [
    ['knowledge', 'knowledge'],
    ['experiences', 'experience'],
  ] as const) {
    for (const e of read(sub)) {
      if (e.isDir || !e.name.endsWith('.md')) continue;
      entries.push({ kind, name: e.name.replace(/\.md$/, ''), path: join(dir, sub, e.name) });
    }
  }
  return { index: readHumanMeta(humanId), indexPath: humanMetaPath(humanId), entries };
}

/** Input text for the "Regenerate summary" LLM call, built from the meta
 *  knowledge base. Returns '' when the human has accumulated nothing yet —
 *  callers must then skip the LLM entirely instead of asking it to summarize
 *  emptiness (that is how the old pipeline produced "暂无足够记录。" for
 *  humans with a full meta.md). */
export function humanMetaSummaryInput(humanId: string): string {
  const e = readHumanMetaEntries(humanId);
  if (!e.index && !e.entries.length) return '';
  const parts: string[] = [];
  if (e.index) parts.push(`Knowledge index (meta.md):\n${e.index}`);
  const section = (label: string, kind: HumanMetaEntry['kind']): void => {
    const names = e.entries.filter((x) => x.kind === kind).map((x) => `- ${x.name}`);
    if (names.length) parts.push(`${label}:\n${names.join('\n')}`);
  };
  section('Skills', 'skill');
  section('Knowledge notes', 'knowledge');
  section('Experiences', 'experience');
  return parts.join('\n\n');
}

/** Recall surface = the human's meta.md knowledge index (maintained by the
 *  handoff session). We inject ONLY the index + a directive to read the
 *  referenced file on demand — not the full skills/experiences (those live
 *  in files the model loads when relevant).
 *
 *  Shared by two call sites that must stay in lockstep: `manager.spawn()`
 *  (fresh process, injected via `--append-system-prompt`) and the
 *  SessionStart hook's `source: "clear"` path (same process, injected via
 *  hook stdout) — `/clear` wipes whatever the CLI flag set, so the hook has
 *  to re-derive the identical text to not silently lose the human's
 *  knowledge index + the "no fixed workspace" directory hint. */
export interface RecallInput {
  /** the human's meta.md knowledge index ('' when they have none yet) */
  meta: string;
  metaDir: string;
  /** directory-less session: the project dirs this human is known to work in */
  knownDirs?: string[];
  /** who this session is: the Human's name, role, and (when set) the scope
   *  they are responsible for. Until now only chat mode told a session who it
   *  was — a normal session saw the knowledge index and nothing else, so the
   *  role was a label on a tab. Humans from before `duties` existed simply
   *  have no scope paragraph; they still get the identity line. */
  who?: { name: string; role: string; duties?: string };
  /** The session's project dir. Present ⇒ the session gets the working method:
   *  delegate self-contained work to sub-agents, keep the conversation to the
   *  task at hand plus the project's high-level shape, and push detail into
   *  `<projectDir>/docs` under one overview + layered indexes. A
   *  directory-less session has no project to own docs for, so it is omitted
   *  there (the paths would be wrong in every project it cd's into). */
  projectDir?: string;
}

export function recallPrompt(input: RecallInput): string | undefined {
  const { meta, metaDir, knownDirs, who, projectDir } = input;
  if (!meta && !knownDirs && !who && !projectDir) return undefined;
  const parts: string[] = [getPrompt('recallPreamble').trim()];
  if (who) {
    parts.push(
      '\n## Who you are',
      `You are ${who.name}, the team's ${who.role}.`,
      ...(who.duties
        ? [
            'What you are responsible for:',
            who.duties,
            'Work within that. If a task falls outside it, say so and hand it back rather than quietly taking it on — a teammate owns that part.',
          ]
        : []),
    );
  }
  if (knownDirs) {
    parts.push(
      '\n## No fixed workspace (direct session)',
      'There is no project bound to this session. Decide which project the task concerns, then `cd` into it with Bash before working. Project directories you know:',
      ...(knownDirs.length > 0
        ? knownDirs.map((d) => `- ${d}`)
        : ['- (none recorded yet — ask the user which directory to work in)']),
    );
  }
  if (meta) {
    parts.push(
      '\n## Your knowledge index (meta.md)',
      `This is a summary of your accumulated skills, knowledge and experience. The full content of each entry lives in a file under ${metaDir} (paths below are relative to that dir). When a task relates to an entry, READ that file before proceeding. Do not assume — load it.`,
      '',
      meta,
    );
  }
  if (projectDir) {
    // Last on purpose: the /clear hook caps what it can print back into
    // context, and it cuts the tail — losing the working method costs less
    // than losing the knowledge index above it.
    parts.push('', getPrompt('delegation', { DOCS_DIR: join(projectDir, 'docs') }).trim());
  }
  return parts.join('\n');
}

/** Whether a SessionStart hook should print the recall text back into the
 *  session's context, given the `source` claude reports.
 *
 *  Measured on claude 2.1.268, because the answer is not what the CLI flags
 *  suggest: `--append-system-prompt` is SILENTLY DROPPED on `--resume`. A
 *  conversation started with one secret in its appended prompt and resumed
 *  with a different one could still only see the first (and the resumed
 *  transcript contains no trace of the second). A SessionStart hook's stdout,
 *  by contrast, does reach the model on resume — same probe, the model read
 *  the hook's secret back.
 *
 *  So the hook owns every case where the launch flag cannot deliver:
 *   • `clear`  — rotates to a new conversation and wipes what the flag set
 *   • `resume` — the flag is dropped; this is also the ONLY way an existing
 *     session ever picks up a changed prompt or a knowledge index written
 *     since it was born
 *   • `compact` — Claude Code's own context compaction replaces the history
 *     with a summary. A session resumed after a restart has its recall ONLY
 *     in that history (the flag was dropped on resume), so compaction
 *     summarized away who it is, its knowledge index and its working rules,
 *     and nothing put them back (09-23).
 *   • `startup` — the flag already carried it; printing it again would only
 *     pay for the same text twice.
 */
export function recallNeedsReinjection(source: string | undefined): boolean {
  return source === 'clear' || source === 'resume' || source === 'compact';
}

/*
 * Claude Code now compacts a full conversation on its own (auto-compact, seen
 * at 967K of a 1M window) — a hand-off Ateam does not run. Ateam's own
 * hand-off first has the session write what it learned into its knowledge
 * folder; a compaction just summarizes, and the lessons go with the detail.
 * Two hooks put the hand-off's first step back:
 *   • PreCompact — its output is merged into the compaction's instructions,
 *     so the summary is told to end with "## Experience to keep";
 *   • SessionStart `compact` — with the recall, the session is told to save
 *     that section into its knowledge folder before going on.
 * Both only for a session that has a teammate (a knowledge folder to save to).
 */

/** The limits `{{SIZE_RULE}}` states in words (prompts/sizeRule.txt) — kept in
 *  step with it by hand; these are the numbers the measurement uses. */
export const META_INDEX_LIMIT = 4_000;
export const ENTRY_LIMIT = 6_000;

/**
 * The knowledge folder's size, measured, for the prompts that write to it —
 * '' when it is within the limits.
 *
 * The size rule alone is a general instruction: a session adding one entry to
 * an 11,388-character index does not know it is nearly three times over, and
 * does the smallest thing. So when the index IS over, the prompt says by how
 * much and that condensing it comes first in this step. Oversized entries are
 * listed too, but only to be split when next touched — a checkpoint must not
 * turn into rewriting ten long files.
 */
export function knowledgeSizeStatus(humanId: string): string {
  const dir = humanMetaDir(humanId);
  let index = 0;
  try {
    index = readFileSync(join(dir, 'meta.md'), 'utf8').length;
  } catch {
    return '';
  }
  const big: { path: string; chars: number }[] = [];
  const walk = (rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(join(dir, rel));
    } catch {
      return;
    }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      if (n.endsWith('.md')) {
        if (r === 'meta.md') continue;
        try {
          const chars = readFileSync(join(dir, r), 'utf8').length;
          if (chars > ENTRY_LIMIT) big.push({ path: r, chars });
        } catch {
          /* unreadable — skip */
        }
      } else if (!n.includes('.')) walk(r);
    }
  };
  walk('');
  const lines: string[] = [];
  if (index > META_INDEX_LIMIT)
    lines.push(
      `Measured now: your meta.md is ${index.toLocaleString('en-US')} characters — over the ${META_INDEX_LIMIT.toLocaleString('en-US')} limit, and every session loads all of it. Condense it FIRST in this step, down to the limit: one line per entry, detail moved into the entries. Keep every entry; shorten how each is described.`,
    );
  if (big.length > 0) {
    big.sort((a, b) => b.chars - a.chars);
    const shown = big
      .slice(0, 5)
      .map((b) => `${b.path} (${b.chars.toLocaleString('en-US')})`)
      .join(', ');
    lines.push(
      `Entries over ${ENTRY_LIMIT.toLocaleString('en-US')} characters: ${shown}${big.length > 5 ? `, and ${big.length - 5} more` : ''}. Split one by topic when you next edit it — not all of them now.`,
    );
  }
  return lines.join('\n');
}

/** Instructions for the compaction's summary: keep what was learned. */
export function compactKeepFor(humanId: string): string | undefined {
  if (!getHuman(humanId)) return undefined;
  return getPrompt('compactKeep', { META_DIR: humanMetaDir(humanId) }).trim();
}

/** Told right after a compaction: save what the summary kept. */
export function compactSaveFor(humanId: string): string | undefined {
  if (!getHuman(humanId)) return undefined;
  return getPrompt('compactSave', {
    META_DIR: humanMetaDir(humanId),
    SIZE_STATUS: knowledgeSizeStatus(humanId),
  }).trim();
}

/** The recall text for one spawn, assembled from everything the human has.
 *
 *  BOTH injection points go through here — `manager.spawn()` (via the
 *  rpc-server's recall fn, `--append-system-prompt`) and the SessionStart
 *  hook's `/clear` path (same text, printed back into context). They used to
 *  each assemble the arguments themselves and had already drifted once; one
 *  function means they cannot. */
export function recallFor(
  humanId: string,
  opts: { cwd?: string; directoryless?: boolean } = {},
): string | undefined {
  ensureHumanMetaDir(humanId);
  const h = getHuman(humanId);
  const knownDirs = opts.directoryless
    ? (h?.projects ?? [])
        .filter((p) => existsSync(p.dir))
        .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1))
        .map((p) => p.dir)
    : undefined;
  return recallPrompt({
    meta: readHumanMeta(humanId),
    metaDir: humanMetaDir(humanId),
    ...(knownDirs ? { knownDirs } : {}),
    ...(h
      ? { who: { name: h.name, role: h.role, ...(h.duties ? { duties: h.duties } : {}) } }
      : {}),
    ...(!opts.directoryless && opts.cwd ? { projectDir: opts.cwd } : {}),
  });
}
