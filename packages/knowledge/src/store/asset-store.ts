import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decayConfidence, initialConfidence, reinforceConfidence } from '../model/confidence';
import type { Confidence } from '../model/types';
import { parseMeta, serialize } from './markdown';

export type Scope = 'project' | 'global';

/** A Skill or Knowledge doc — user-provided, distilled, or learned. */
export interface StoredSkill {
  id: string;
  agentKey: string;
  scope: Scope;
  projectId?: string;
  /** 'skill' = how-to/procedure · 'knowledge' = facts/spec */
  kind: 'skill' | 'knowledge';
  domain: string;
  name: string;
  description: string;
  body: string;
  source: 'user_provided' | 'distilled' | 'learned';
  tags: string[];
  createdAt: string;
  appliedCount: number;
  /** the vault dir owning the skill's real files (single source of truth) */
  bundlePath?: string;
  /** entry doc within the bundle (relative) */
  entryFile?: string;
  /** where the original now lives as a symlink back into the vault */
  originalPath?: string;
}
export interface SkillInput {
  agentKey: string;
  scope: Scope;
  projectId?: string;
  kind?: 'skill' | 'knowledge';
  domain: string;
  name: string;
  description?: string;
  body: string;
  source: 'user_provided' | 'distilled' | 'learned';
  tags?: string[];
  bundlePath?: string;
  entryFile?: string;
  originalPath?: string;
}

/** Lean persisted Experience — the flywheel's primary, gate-critical asset. */
export interface StoredExperience {
  id: string;
  /** stable knowledge owner (M2: the role, e.g. "coder"); roles are assets */
  agentKey: string;
  scope: Scope;
  projectId?: string;
  domain: string;
  title: string;
  narrative: string;
  lessonLearned: string;
  generalization: string;
  tags: string[];
  techStack: string[];
  createdAt: string;
  appliedCount: number;
  confidence: Confidence;
}

export interface ExperienceInput {
  agentKey: string;
  scope: Scope;
  projectId?: string;
  domain: string;
  title: string;
  narrative: string;
  lessonLearned: string;
  generalization?: string;
  tags?: string[];
  techStack?: string[];
}

export interface SearchHit {
  exp: StoredExperience;
  score: number;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'untitled'
  );
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9一-龥]+/)
    .filter((t) => t.length > 1);
}

/**
 * Markdown-backed Experience store with an in-memory keyword index.
 * Layout: <root>/users/local/agents/<agentKey>/{global|projects/<pid>}/experiences/*.md
 * SQLite + sqlite-vec slots behind this same interface in a later increment.
 */
export class AssetStore {
  private readonly cache = new Map<string, StoredExperience>();
  private readonly skills = new Map<string, StoredSkill>();

  constructor(private readonly root: string) {
    this.loadAll();
  }

  private scopedDir(
    agentKey: string,
    scope: Scope,
    projectId: string | undefined,
    kind: string,
  ): string {
    const base = join(this.root, 'users', 'local', 'agents', agentKey);
    const scoped =
      scope === 'global' ? join(base, 'global') : join(base, 'projects', projectId ?? 'unknown');
    return join(scoped, kind);
  }
  private expDir(agentKey: string, scope: Scope, projectId?: string): string {
    return this.scopedDir(agentKey, scope, projectId, 'experiences');
  }
  private skillDir(agentKey: string, scope: Scope, projectId?: string): string {
    return this.scopedDir(agentKey, scope, projectId, 'skills');
  }

  private loadAll(): void {
    const agentsRoot = join(this.root, 'users', 'local', 'agents');
    if (!existsSync(agentsRoot)) return;
    // mode: 'none' ignore · 'exp' experience records · 'skills' skills root
    //  (only files in skills/.index are records; copied skill trees ignored)
    type Mode = 'none' | 'exp' | 'skills' | 'skillidx';
    const walk = (dir: string, mode: Mode): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          let m: Mode = mode;
          if (e.name === 'experiences') m = 'exp';
          else if (e.name === 'skills') m = 'skills';
          else if (mode === 'skills') m = e.name === '.index' ? 'skillidx' : 'none';
          else if (mode === 'skillidx') m = 'skillidx';
          else if (mode === 'none') m = 'none';
          walk(p, m);
        } else if (e.name.endsWith('.md')) {
          if (mode === 'skillidx') {
            const s = parseMeta<StoredSkill>(readFileSync(p, 'utf8'));
            if (s?.id) this.skills.set(s.id, s);
          } else if (mode === 'exp') {
            const x = parseMeta<StoredExperience>(readFileSync(p, 'utf8'));
            if (x?.id) this.cache.set(x.id, x);
          }
        }
      }
    };
    try {
      walk(agentsRoot, 'none');
    } catch {
      /* tolerate a partially-written tree */
    }
  }

  saveExperience(input: ExperienceInput): StoredExperience {
    const now = new Date().toISOString();
    const exp: StoredExperience = {
      id: randomUUID(),
      agentKey: input.agentKey,
      scope: input.scope,
      projectId: input.projectId,
      domain: input.domain,
      title: input.title,
      narrative: input.narrative,
      lessonLearned: input.lessonLearned,
      generalization: input.generalization ?? '',
      tags: input.tags ?? [],
      techStack: input.techStack ?? [],
      createdAt: now,
      appliedCount: 0,
      confidence: initialConfidence(
        input.scope === 'global' ? 'multi_project' : 'single_project',
        now,
      ),
    };
    this.write(exp);
    this.cache.set(exp.id, exp);
    return exp;
  }

  private write(exp: StoredExperience): void {
    const dir = this.expDir(exp.agentKey, exp.scope, exp.projectId);
    mkdirSync(dir, { recursive: true });
    const body =
      `# ${exp.title}\n\n` +
      `*domain: ${exp.domain} · tags: ${exp.tags.join(', ')}*\n\n` +
      `## 叙述\n${exp.narrative}\n\n` +
      `## 教训\n${exp.lessonLearned}\n\n` +
      `## 通用结论\n${exp.generalization}\n`;
    writeFileSync(
      join(dir, `${exp.createdAt.slice(0, 10)}-${slug(exp.title)}.md`),
      serialize(exp, body),
    );
  }

  listExperiences(filter: {
    agentKey: string;
    scope?: Scope;
    projectId?: string;
    domain?: string;
  }): StoredExperience[] {
    return [...this.cache.values()]
      .filter(
        (e) =>
          e.agentKey === filter.agentKey &&
          (filter.scope === undefined || e.scope === filter.scope) &&
          (filter.projectId === undefined || e.projectId === filter.projectId) &&
          (filter.domain === undefined || e.domain === filter.domain),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Keyword search (term overlap + domain/tag boost + confidence weight). */
  search(
    agentKey: string,
    query: string,
    opts: { domain?: string; projectId?: string; topK?: number } = {},
  ): SearchHit[] {
    const q = new Set(tokenize(query));
    if (opts.domain) for (const t of tokenize(opts.domain)) q.add(t);
    const hits: SearchHit[] = [];
    for (const e of this.cache.values()) {
      if (e.agentKey !== agentKey) continue;
      const hay = tokenize(
        `${e.title} ${e.narrative} ${e.lessonLearned} ${e.generalization} ${e.tags.join(' ')} ${e.domain} ${e.techStack.join(' ')}`,
      );
      const hayset = new Set(hay);
      let overlap = 0;
      for (const t of q) if (hayset.has(t)) overlap++;
      if (overlap === 0 && opts.domain !== e.domain) continue;
      const domainBoost = opts.domain && opts.domain === e.domain ? 1.5 : 1;
      const recency = e.projectId === opts.projectId ? 1.2 : 1;
      const score = (overlap + (domainBoost - 1) * 2) * e.confidence.value * domainBoost * recency;
      if (score > 0) hits.push({ exp: e, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, opts.topK ?? 5);
  }

  markApplied(id: string): void {
    const e = this.cache.get(id);
    if (!e) return;
    const updated: StoredExperience = {
      ...e,
      appliedCount: e.appliedCount + 1,
      confidence: reinforceConfidence(e.confidence, new Date().toISOString()),
    };
    this.cache.set(id, updated);
    this.write(updated);
  }

  all(): StoredExperience[] {
    return [...this.cache.values()];
  }

  /** ④ Meta decay pass: re-age every experience's confidence, persist. */
  decayAll(now: string = new Date().toISOString()): number {
    let n = 0;
    for (const e of [...this.cache.values()]) {
      const c = decayConfidence(e.confidence, now);
      if (c.value !== e.confidence.value) {
        const updated = { ...e, confidence: c };
        this.cache.set(e.id, updated);
        this.write(updated);
        n++;
      }
    }
    return n;
  }

  // --- Skills / Knowledge (user_provided | distilled | learned) ---

  saveSkill(input: SkillInput): StoredSkill {
    const sk: StoredSkill = {
      id: randomUUID(),
      agentKey: input.agentKey,
      scope: input.scope,
      projectId: input.projectId,
      kind: input.kind ?? 'skill',
      domain: input.domain,
      name: input.name,
      description: input.description ?? '',
      body: input.body,
      source: input.source,
      tags: input.tags ?? [],
      createdAt: new Date().toISOString(),
      appliedCount: 0,
      bundlePath: input.bundlePath,
      entryFile: input.entryFile,
      originalPath: input.originalPath,
    };
    this.writeSkillIndex(sk);
    this.skills.set(sk.id, sk);
    this.writeManifest(sk.agentKey, sk.scope, sk.projectId);
    return sk;
  }

  private skillIndexPath(sk: StoredSkill): string {
    return join(
      this.skillDir(sk.agentKey, sk.scope, sk.projectId),
      '.index',
      `${slug(sk.name)}.md`,
    );
  }

  private writeSkillIndex(sk: StoredSkill): void {
    const p = this.skillIndexPath(sk);
    mkdirSync(join(p, '..'), { recursive: true });
    const md =
      `# ${sk.name}\n\n*kind: ${sk.kind} · domain: ${sk.domain} · source: ${sk.source}*\n\n` +
      `${sk.description ? `> ${sk.description}\n\n` : ''}${sk.bundlePath ? `files: ${sk.bundlePath}\n\n` : ''}`;
    writeFileSync(p, serialize(sk, md));
  }

  /** Every skill record across all scopes/projects (migration/maintenance). */
  allSkills(): StoredSkill[] {
    return [...this.skills.values()];
  }

  /** Drop a skill record: its `.index` md + in-memory entry + manifest. The
   *  bundle's real files are NOT touched (a spurious index dup may share a
   *  bundle with the canonical record). */
  deleteSkill(id: string): void {
    const sk = this.skills.get(id);
    if (!sk) return;
    try {
      rmSync(this.skillIndexPath(sk), { force: true });
    } catch {
      /* best-effort */
    }
    this.skills.delete(id);
    this.writeManifest(sk.agentKey, sk.scope, sk.projectId);
  }

  /** Re-derive a skill's capability blurb (migration: stale/empty ones). */
  updateSkillDescription(id: string, description: string): void {
    const sk = this.skills.get(id);
    if (!sk || sk.description === description) return;
    const next = { ...sk, description };
    this.writeSkillIndex(next);
    this.skills.set(id, next);
    this.writeManifest(sk.agentKey, sk.scope, sk.projectId);
  }

  /** Absolute dir the skill's full tree is copied into (no _bundles wrapper). */
  skillContentDir(agentKey: string, scope: Scope, slugName: string, projectId?: string): string {
    return join(this.skillDir(agentKey, scope, projectId), slug(slugName));
  }

  /** Per-human skill 总纲 — what skills exist, what they're for, where to read
   *  them. Injected at spawn so the LLM loads the right one on demand.
   *
   *  Scope filter (plan §5 "始终查全局+当前项目；技能取全局主干"):
   *   - no opts          → every skill (the on-disk per-scope INDEX.md)
   *   - { projectId }    → global skills + that one project's skills
   *   - { globalOnly }   → global skills only (directory-less session)
   *  Project-scoped skills never leak into an unrelated project's session. */
  manifestText(agentKey: string, opts?: { projectId?: string; globalOnly?: boolean }): string {
    const all = [...this.skills.values()].filter((s) => {
      if (s.agentKey !== agentKey) return false;
      if (!opts) return true;
      if (s.scope === 'global') return true;
      if (opts.globalOnly) return false;
      return opts.projectId !== undefined && s.projectId === opts.projectId;
    });
    if (all.length === 0) return '';
    const line = (s: StoredSkill): string =>
      `- [${s.kind}] ${s.name} (domain: ${s.domain}; ${s.scope}${s.source === 'learned' ? '; learned' : ''})` +
      `${s.description ? ` — ${s.description}` : ''}` +
      `${s.bundlePath ? `\n  files: ${s.bundlePath}${s.entryFile ? ` (start: ${s.entryFile})` : ''}` : ''}`;
    return all.map(line).join('\n');
  }

  private writeManifest(agentKey: string, scope: Scope, projectId?: string): void {
    const dir = this.skillDir(agentKey, scope, projectId);
    mkdirSync(dir, { recursive: true });
    const text = this.manifestText(agentKey);
    writeFileSync(
      join(dir, 'INDEX.md'),
      `# Skills 总纲 — ${agentKey}\n\nRead the files at the listed paths when a skill is relevant.\n\n${text}\n`,
    );
  }

  listSkills(filter: { agentKey: string; scope?: Scope; projectId?: string }): StoredSkill[] {
    return [...this.skills.values()]
      .filter(
        (s) =>
          s.agentKey === filter.agentKey &&
          (filter.scope === undefined || s.scope === filter.scope) &&
          (filter.projectId === undefined || s.projectId === filter.projectId),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  searchSkills(
    agentKey: string,
    query: string,
    opts: { domain?: string; topK?: number } = {},
  ): StoredSkill[] {
    const q = new Set(tokenize(query));
    if (opts.domain) for (const t of tokenize(opts.domain)) q.add(t);
    const scored: { s: StoredSkill; score: number }[] = [];
    for (const s of this.skills.values()) {
      if (s.agentKey !== agentKey) continue;
      const hay = new Set(
        tokenize(`${s.name} ${s.description} ${s.body} ${s.tags.join(' ')} ${s.domain}`),
      );
      let overlap = 0;
      for (const t of q) if (hay.has(t)) overlap++;
      // user_provided/learned skills are curated -> always eligible
      const base = s.source === 'distilled' ? overlap : overlap + 1;
      if (base <= 0) continue;
      scored.push({ s, score: base * (opts.domain === s.domain ? 1.5 : 1) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.topK ?? 6).map((x) => x.s);
  }

  /** ⑥⑦ per-domain专业度 derived from accumulated experience. */
  expertise(agentKey: string): DomainExpertise[] {
    const byDomain = new Map<string, StoredExperience[]>();
    for (const e of this.cache.values()) {
      if (e.agentKey !== agentKey) continue;
      const a = byDomain.get(e.domain) ?? [];
      a.push(e);
      byDomain.set(e.domain, a);
    }
    const res: DomainExpertise[] = [];
    for (const [domain, es] of byDomain) {
      const count = es.length;
      const applied = es.reduce((s, e) => s + e.appliedCount, 0);
      const avgConfidence = es.reduce((s, e) => s + e.confidence.value, 0) / count;
      const level: ExpertiseLevel =
        count >= 5 && avgConfidence >= 0.8 ? 'expert' : count >= 3 ? 'senior' : 'intermediate';
      res.push({
        domain,
        count,
        applied,
        avgConfidence,
        score: count * avgConfidence + applied,
        level,
      });
    }
    return res.sort((a, b) => b.score - a.score);
  }

  /** ⑥ growth report — what this agent has become. */
  growth(agentKey: string): GrowthReport {
    const mine = this.listExperiences({ agentKey });
    return {
      agentKey,
      totalExperiences: mine.length,
      domains: this.expertise(agentKey),
      recent: mine.slice(0, 8).map((e) => ({
        title: e.title,
        domain: e.domain,
        createdAt: e.createdAt,
        appliedCount: e.appliedCount,
        confidence: e.confidence.value,
      })),
    };
  }
}

export type ExpertiseLevel = 'intermediate' | 'senior' | 'expert';
export interface DomainExpertise {
  domain: string;
  count: number;
  applied: number;
  avgConfidence: number;
  score: number;
  level: ExpertiseLevel;
}
export interface GrowthReport {
  agentKey: string;
  totalExperiences: number;
  domains: DomainExpertise[];
  recent: {
    title: string;
    domain: string;
    createdAt: string;
    appliedCount: number;
    confidence: number;
  }[];
}
