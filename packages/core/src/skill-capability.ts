/**
 * Skill metadata extraction shared by the adoption path (flywheel) and the
 * one-time description-refresh migration: a real one-line capability blurb so
 * the injected 总纲 lets the LLM decide whether a skill is relevant.
 */

export interface Frontmatter {
  domain?: string;
  tags?: string[];
  title?: string;
  description?: string;
}

export function frontmatter(md: string): Frontmatter {
  const out: Frontmatter = {};
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (fm?.[1]) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2]?.trim().replace(/^["']|["']$/g, '');
      if (key === 'domain') out.domain = val;
      else if (key === 'tags') out.tags = m[2]?.split(/[,\s]+/).filter(Boolean);
      else if (key === 'name' || key === 'title') out.title = val;
      else if (key === 'description' || key === 'summary' || key === 'about') out.description = val;
    }
  }
  const h1 = md.match(/^#\s+(.+)$/m);
  if (h1?.[1] && !out.title) out.title = h1[1].trim();
  return out;
}

/** Prefer frontmatter `description`, else the first real prose line of the
 *  body (skip headings/lists/quotes/fences/tables). '' if nothing usable. */
export function skillCapability(md: string, fm: Frontmatter = frontmatter(md)): string {
  const d = (fm.description ?? '').trim();
  if (d) return d.slice(0, 200);
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (
      !line ||
      line.startsWith('#') ||
      line.startsWith('>') ||
      line.startsWith('```') ||
      line.startsWith('|') ||
      /^[-*+]\s/.test(line) ||
      /^\d+\.\s/.test(line)
    )
      continue;
    return line.replace(/[*_`]/g, '').slice(0, 200);
  }
  return '';
}

/** True for the useless auto-text earlier code stored as a description, or
 *  an empty one — i.e. a record whose blurb must be re-derived. */
export function isStaleDescription(d: string): boolean {
  const t = d.trim();
  return (
    t === '' ||
    /^bundle \(/.test(t) ||
    t.includes('files preserved at the path below') ||
    /^skill bundle:/.test(t)
  );
}
