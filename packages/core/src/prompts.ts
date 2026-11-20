import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { ateamHome } from './paths';

/**
 * All prompts the flywheel sends to the LLM live as plain .txt files in
 * `packages/core/prompts/` so they can be edited in the repo without
 * touching TS source. At runtime we read fresh on every call (small
 * files; cheap). `{{LANG_RULE}}` placeholders auto-resolve from
 * `lang.txt`; per-call `{{VAR}}` placeholders are substituted from `vars`.
 *
 * Located via __dirname candidates — covers both:
 *   • tsx dev (core/src → ../prompts = packages/core/prompts)
 *   • bundled sidecar (apps/sidecar/dist/index.cjs → ./prompts; the bundle
 *     copy step in apps/sidecar/scripts/bundle-native.mjs ships them there).
 *
 * The user can override any of them: `~/.ateam/prompts/<name>.txt` wins over
 * the bundled default when it exists (Settings → Prompts writes it). Shipped
 * prompts sit inside a read-only app bundle, so this is the only way an end
 * user can change what the app says to the model — and because every call
 * re-reads, an edit applies to the very next use, no restart.
 */

export type PromptName =
  | 'lang'
  | 'record'
  | 'recallPreamble'
  | 'codexProgress'
  | 'reflect'
  | 'distill'
  | 'learn'
  | 'summarize'
  | 'handoff'
  | 'compactKeep'
  | 'compactSave'
  | 'checkpoint'
  | 'sizeRule'
  | 'codegraphHint'
  | 'delegation'
  | 'peerCollab';

export interface PromptMeta {
  title: string;
  /** when the app actually sends it — the thing a user needs to know before
   *  editing it */
  when: string;
  /** false for prompts nothing triggers by default any more; they are still
   *  listed (they are real files and still honoured if re-enabled), just not
   *  presented as if they shaped today's sessions */
  live: boolean;
}

/** Every prompt a user can edit, in the order Settings shows them. `record`
 *  is absent on purpose: nothing sends it (its caller was removed with the
 *  drops inbox), and an editable prompt that does nothing is a trap. */
export const EDITABLE_PROMPTS: Readonly<Record<Exclude<PromptName, 'record'>, PromptMeta>> = {
  codexProgress: {
    title: 'Codex progress reporting',
    when: 'Appended to Codex developer instructions on launch and resume. Only background tasks and sub-agents report periodic progress; ordinary foreground replies do not.',
    live: true,
  },
  recallPreamble: {
    title: 'Session preamble',
    when: "The first line of every session's system prompt — at start, on resume, and after /clear.",
    live: true,
  },
  delegation: {
    title: 'Working method & project docs',
    when: "Appended to every project session: hand self-contained work to sub-agents, keep durable detail in docs/ (one overview + layered indexes), and how to answer. {{DOCS_DIR}} becomes the project's docs folder.",
    live: true,
  },
  peerCollab: {
    title: 'Cross-session collaboration privacy',
    when: 'Appended to every session at start/resume: when another session asks for collaboration, reply with results only; if unsure whether to expose detail, ask this session\'s user first and wait for approval.',
    live: true,
  },
  codegraphHint: {
    title: 'Code search hint',
    when: 'Appended to project sessions when CodeGraph is enabled, so the agent reaches for the code graph before grep.',
    live: true,
  },
  handoff: {
    title: 'Auto-handoff',
    when: 'Sent to a session nearing its context threshold: update the knowledge index, then write the handoff document the successor starts from.',
    live: true,
  },
  checkpoint: {
    title: 'Experience checkpoint',
    when: 'Sent once per compaction cycle to a session past the checkpoint threshold (Settings → Sessions): save what it has learned into its knowledge folder while the whole conversation is still in context, then carry on — it is not replaced. {{TOKENS}} and {{META_DIR}} are filled in.',
    live: true,
  },
  sizeRule: {
    title: 'Knowledge size limits',
    when: 'Not sent on its own — it replaces {{SIZE_RULE}} in the hand-off, checkpoint and post-compaction prompts, so every place that writes the knowledge folder keeps meta.md and each entry within the same limits.',
    live: true,
  },
  compactKeep: {
    title: "Claude's own compaction — what the summary keeps",
    when: "Added to the instructions of Claude Code's context compaction (auto or /compact), through a PreCompact hook: the summary must end with a '## Experience to keep' section, so what was learned is not summarized away. {{META_DIR}} becomes the teammate's knowledge folder.",
    live: true,
  },
  compactSave: {
    title: "Claude's own compaction — saving what it kept",
    when: "Sent right after a compaction (SessionStart, source 'compact'), with the session preamble: save the summary's '## Experience to keep' into the knowledge folder before going on.",
    live: true,
  },
  summarize: {
    title: 'Teammate summary',
    when: "Used by Team → Regenerate summary to write a teammate's profile from their knowledge base.",
    live: true,
  },
  lang: {
    title: 'Language rule',
    when: 'Not sent on its own — it replaces {{LANG_RULE}} inside the other prompts (handoff, summary, and the dormant flywheel ones).',
    live: true,
  },
  reflect: {
    title: 'Reflect (flywheel)',
    when: 'Dormant: only the flywheel.reflect RPC uses it, and no screen calls that any more.',
    live: false,
  },
  distill: {
    title: 'Distill (flywheel)',
    when: 'Dormant: only the periodic meta-agent sweep uses it, which runs only with ATEAM_AUTOEVOLVE=1.',
    live: false,
  },
  learn: {
    title: 'Learn (flywheel)',
    when: 'Dormant: nothing calls it today.',
    live: false,
  },
};
export type EditablePromptName = keyof typeof EDITABLE_PROMPTS;
export const isEditablePrompt = (name: string): name is EditablePromptName =>
  Object.hasOwn(EDITABLE_PROMPTS, name);

/** An override bigger than this is a paste accident, not a prompt. */
export const PROMPT_MAX_CHARS = 64_000;

let cachedDir: string | undefined;

function promptsDir(): string {
  if (cachedDir) return cachedDir;
  const here = typeof __dirname !== 'undefined' ? __dirname : dirname(process.argv[1] ?? '.');
  const candidates = [
    join(here, 'prompts'), // bundled sidecar (dist/prompts)
    join(here, '..', 'prompts'), // tsx dev (packages/core/src → ../prompts)
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedDir = c;
      return c;
    }
  }
  cachedDir = candidates[0] ?? '';
  return cachedDir;
}

export function promptOverrideDir(): string {
  return join(ateamHome(), 'prompts');
}
const overridePath = (name: PromptName): string => join(promptOverrideDir(), `${name}.txt`);

function readDefault(name: PromptName): string {
  try {
    return readFileSync(join(promptsDir(), `${name}.txt`), 'utf8');
  } catch {
    return '';
  }
}

/** The user's override when there is one, else the bundled default. */
function readRaw(name: PromptName): string {
  const o = overridePath(name);
  if (existsSync(o)) {
    try {
      return readFileSync(o, 'utf8');
    } catch {
      /* unreadable override → the default still works */
    }
  }
  return readDefault(name);
}

/** `{{NAME}}` placeholders in a prompt, sorted, each once. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/{{([A-Z_]+)}}/g)].map((m) => m[1] as string))].sort();
}

export interface PromptInfo extends PromptMeta {
  name: EditablePromptName;
  customized: boolean;
  /** what the app sends now (override or default), before substitution */
  text: string;
  defaultText: string;
  /** placeholders the default relies on — removing one is allowed, but the
   *  value the app fills in then goes nowhere */
  placeholders: string[];
}

export function listPrompts(): PromptInfo[] {
  return (Object.keys(EDITABLE_PROMPTS) as EditablePromptName[]).map((name) => {
    const defaultText = readDefault(name);
    return {
      name,
      ...EDITABLE_PROMPTS[name],
      customized: existsSync(overridePath(name)),
      text: readRaw(name),
      defaultText,
      placeholders: placeholdersIn(defaultText),
    };
  });
}

/** Save an override. Returns the default's placeholders the new text no
 *  longer contains — the caller warns; saving is not refused. */
export function setPromptOverride(name: string, text: string): { missingPlaceholders: string[] } {
  if (!isEditablePrompt(name)) throw new Error(`not an editable prompt: ${name}`);
  if (text.length > PROMPT_MAX_CHARS) {
    throw new Error(`prompt too long (${text.length} > ${PROMPT_MAX_CHARS} characters)`);
  }
  mkdirSync(promptOverrideDir(), { recursive: true });
  const path = overridePath(name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path); // atomic: a reader never sees half a prompt
  const present = new Set(placeholdersIn(text));
  return { missingPlaceholders: placeholdersIn(readDefault(name)).filter((p) => !present.has(p)) };
}

/** Back to the bundled default. */
export function resetPromptOverride(name: string): void {
  if (!isEditablePrompt(name)) throw new Error(`not an editable prompt: ${name}`);
  try {
    unlinkSync(overridePath(name));
  } catch {
    /* no override — already the default */
  }
}

/** Read a prompt file with substitutions. `{{LANG_RULE}}` auto-resolves
 *  from lang.txt so editing it in one place updates every nested prompt. */
export function getPrompt(name: PromptName, vars: Record<string, string> = {}): string {
  let text = readRaw(name);
  if (name !== 'lang') text = text.replaceAll('{{LANG_RULE}}', readRaw('lang').trim());
  if (name !== 'sizeRule') text = text.replaceAll('{{SIZE_RULE}}', readRaw('sizeRule').trim());
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
  // measured per teammate by the caller; a caller that has none to give
  // (no teammate) must not leave the braces in the text
  return text.replaceAll('{{SIZE_STATUS}}', '');
}
