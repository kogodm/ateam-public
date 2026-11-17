import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { maskOutput } from './external-exec';
import { ensureHumanMetaDir, humanMetaPath, readHumanMetaEntries } from './human-meta';

/**
 * External planners (ChatGPT) think outside any CLI transcript, so the
 * self-evolution flywheel never saw their lessons. They now read and write the
 * memory of the Human whose session did the work: the same meta.md index and
 * knowledge/ experiences/ files the handoff writes, recalled at that Human's
 * next spawn and readable by the next external chat.
 */

const MAX_INDEX = 32 * 1024;
const MAX_ENTRY = 64 * 1024;
const MAX_WRITE = 16 * 1024;
const MARK = '<!-- source: external MCP';

export type MemoryKind = 'experience' | 'knowledge';
const DIR: Record<MemoryKind, string> = { experience: 'experiences', knowledge: 'knowledge' };
const HEADING: Record<MemoryKind, string> = { experience: '## Experiences', knowledge: '## Knowledge' };

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const write = (path: string, text: string) => {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
};

/** The Human's index and entry list, or one entry's text when `entry` names it. */
export function readMemory(humanId: string, humanName: string, entry?: string) {
  const meta = readHumanMetaEntries(humanId);
  if (entry) {
    const want = entry.trim().toLowerCase();
    const hit = meta.entries.find((e) => e.name.toLowerCase() === want);
    if (!hit) throw new Error(`no memory entry named "${entry}" — see entries`);
    const text = readFileSync(hit.path, 'utf8');
    return {
      human: humanName,
      entry: { kind: hit.kind, name: hit.name },
      text: maskOutput(text.slice(0, MAX_ENTRY)),
      truncated: text.length > MAX_ENTRY,
    };
  }
  return {
    human: humanName,
    index: maskOutput(meta.index.slice(0, MAX_INDEX)),
    index_truncated: meta.index.length > MAX_INDEX,
    entries: meta.entries.map((e) => ({ kind: e.kind, name: e.name })),
  };
}

/** One index line under its section, replacing an older line for the same entry. */
export function upsertIndexLine(index: string, kind: MemoryKind, slug: string, summary: string, title: string): string {
  const line = `- **${slug}** — ${summary.replace(/\s+/g, ' ').trim()}`;
  const today = new Date().toISOString().slice(0, 10);
  let lines = (index.trim() ? index : `# ${title} — knowledge index\n_updated: ${today}_\n`).split('\n');
  lines = lines.filter((l) => !l.startsWith(`- **${slug}**`));
  lines = lines.map((l) => (/^_updated: .*_$/.test(l) ? `_updated: ${today}_` : l));
  const head = lines.findIndex((l) => l.trim() === HEADING[kind]);
  if (head < 0) return `${lines.join('\n').trimEnd()}\n\n${HEADING[kind]}\n${line}\n`;
  let end = head + 1;
  while (end < lines.length && !/^#{1,2} /.test(lines[end] as string)) end++;
  while (end > head + 1 && !(lines[end - 1] as string).trim()) end--;
  lines.splice(end, 0, line);
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Write an experience or knowledge note into the Human's meta and index it.
 * An existing note is replaced only when `update` is set and an external
 * client wrote it — notes the Human wrote itself are never overwritten.
 */
export function recordMemory(
  human: { id: string; name: string },
  note: { kind: MemoryKind; name: string; summary: string; content: string; update?: boolean },
  source: string,
) {
  const slug = slugify(note.name);
  if (!slug) throw new Error('name needs letters or digits (it becomes the file name)');
  if (!note.summary.trim() || note.summary.length > 200) throw new Error('summary must be 1–200 characters');
  if (!note.content.trim() || note.content.length > MAX_WRITE) throw new Error('content must be 1–16000 characters');
  const dir = ensureHumanMetaDir(human.id);
  const path = join(dir, DIR[note.kind], `${slug}.md`);
  if (existsSync(path)) {
    if (!note.update) throw new Error(`"${slug}" already exists — pass update: true to replace it, or choose another name`);
    if (!readFileSync(path, 'utf8').includes(MARK))
      throw new Error(`"${slug}" was written by ${human.name} itself and is not replaced; choose another name`);
  }
  const date = new Date().toISOString().slice(0, 10);
  write(path, `${MARK} (${source}), ${date} -->\n\n${maskOutput(note.content.trim())}\n`);
  const indexPath = humanMetaPath(human.id);
  const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  write(indexPath, upsertIndexLine(index, note.kind, slug, maskOutput(note.summary), human.name));
  return { human: human.name, kind: note.kind, name: slug, path: `${DIR[note.kind]}/${slug}.md` };
}
