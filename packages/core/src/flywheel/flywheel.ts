import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { ateamHome } from '../paths';
import { isDoc } from '../skill-sources';

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'skill'
  );
}
import type {
  AssetStore,
  LlmSynthesizer,
  Scope,
  SearchHit,
  StoredExperience,
  StoredSkill,
} from '@ateam/knowledge';
import { readClaudeTranscript, turnsToText } from '../session/transcript-file';
import { frontmatter, skillCapability } from '../skill-capability';

export interface ReflectArgs {
  cwd: string;
  claudeSessionId: string;
  /** stable knowledge owner (M2: the role) */
  agentKey: string;
  scope: Scope;
  projectId?: string;
  domainHint?: string;
  /** incremental: only reflect transcript turns at/after this index */
  sinceTurn?: number;
  /** transcript text cap — defaults to 24k chars (incremental, cheap); the
   *  manual ✨ Reflect path passes a much larger cap so long design sessions
   *  don't lose their early context to truncation. */
  maxChars?: number;
}

/** What a reflection produced — any of these may be empty (nothing valuable).
 *  `skills` holds both kind:'skill' and kind:'knowledge' StoredSkill records. */
export interface ReflectionOutcome {
  experiences: StoredExperience[];
  skills: StoredSkill[];
}

/**
 * The self-evolution loop, single-agent slice (M2 gate):
 *  reflect: transcript -> Experience ①  ·  recall: search ⑦  ·  markApplied ④.
 * Cross-dimension/Meta come next; this proves the core hypothesis.
 */
export class Flywheel {
  constructor(
    private readonly store: AssetStore,
    private readonly synth: LlmSynthesizer,
  ) {}

  /** Reflect over the INCREMENTAL tail of a session's transcript (only turns
   *  at/after `sinceTurn`) → save 0..N experiences/knowledge/skills. */
  async reflect(args: ReflectArgs): Promise<ReflectionOutcome> {
    const turns = readClaudeTranscript(args.cwd, args.claudeSessionId);
    const fresh = args.sinceTurn ? turns.slice(args.sinceTurn) : turns;
    if (fresh.length < 2) return { experiences: [], skills: [] };
    return this.reflectFromText(turnsToText(fresh, args.maxChars), args);
  }

  /** Testable core: synthesize from already-flattened transcript text. The
   *  LLM judges value — an empty outcome (nothing worth keeping) is normal.
   *  Reflected knowledge/skills are vault assets (no bundlePath ⇒ they live
   *  only in ~/.ateam, never written back into ~/.claude). */
  async reflectFromText(text: string, args: ReflectArgs): Promise<ReflectionOutcome> {
    const items = await this.synth.reflect(text, { domain: args.domainHint });
    const out: ReflectionOutcome = { experiences: [], skills: [] };
    for (const it of items) {
      const domain = it.domain || args.domainHint || 'general';
      if (it.kind === 'experience') {
        out.experiences.push(
          this.store.saveExperience({
            agentKey: args.agentKey,
            scope: args.scope,
            projectId: args.projectId,
            domain,
            title: it.title,
            narrative: it.body,
            lessonLearned: it.lessonLearned ?? '',
            generalization: it.generalization ?? '',
            tags: it.tags,
            techStack: it.techStack ?? [],
          }),
        );
      } else {
        const skKind = it.kind === 'knowledge' ? 'knowledge' : 'skill';
        // updateOf: replace an existing vault-only record (no bundlePath)
        // before saving — mirrors the drops-inbox behaviour so manual
        // reflection and in-session drops share semantics.
        if (it.updateOf) {
          const target = it.updateOf;
          const existing = this.store
            .allSkills()
            .find(
              (s) =>
                s.agentKey === args.agentKey &&
                s.scope === args.scope &&
                (s.projectId ?? undefined) === (args.projectId ?? undefined) &&
                s.kind === skKind &&
                !s.bundlePath &&
                (s.name === target || s.name === it.title),
            );
          if (existing) this.store.deleteSkill(existing.id);
        }
        out.skills.push(
          this.store.saveSkill({
            agentKey: args.agentKey,
            scope: args.scope,
            projectId: args.projectId,
            kind: skKind,
            domain,
            name: it.title,
            description: it.description ?? '',
            body: it.body,
            source: 'distilled',
            tags: it.tags,
          }),
        );
      }
    }
    return out;
  }

  /** ⑦ recall: what does this agent already know that helps here? */
  recall(
    agentKey: string,
    query: string,
    opts?: { domain?: string; projectId?: string; topK?: number },
  ): SearchHit[] {
    return this.store.search(agentKey, query, opts ?? {});
  }

  /** ④ a recalled experience was actually used: reinforce it. */
  markApplied(id: string): void {
    this.store.markApplied(id);
  }

  listExperiences(agentKey: string): StoredExperience[] {
    return this.store.listExperiences({ agentKey });
  }

  /** ④ Meta decay pass over all experiences. */
  decayAll(): number {
    return this.store.decayAll();
  }

  /** F-Role-03: import user-provided Skill/rule docs for a role. Accepts a
   *  single file OR a directory tree; covers .md/.mdc/.markdown and known
   *  bare-name files (CLAUDE.md, AGENTS.md, .cursorrules, …). */
  importSkillsFromDir(
    agentKey: string,
    pathArg: string,
    scope: Scope = 'global',
    projectId?: string,
  ): number {
    if (!existsSync(pathArg)) return 0;
    let n = 0;
    const ingest = (file: string, parent: string): void => {
      const md = readFileSync(file, 'utf8');
      if (!md.trim()) return;
      const fm = frontmatter(md);
      const fname = basename(file);
      this.store.saveSkill({
        agentKey,
        scope,
        projectId,
        kind: 'skill',
        domain: fm.domain ?? basename(parent) ?? 'general',
        name: fm.title ?? fname.replace(/\.(md|mdc|markdown|mdx)$/i, ''),
        description: skillCapability(md, fm),
        body: md,
        source: 'user_provided',
        tags: fm.tags ?? [],
      });
      n++;
    };
    const st = statSync(pathArg);
    if (st.isFile()) {
      ingest(pathArg, join(pathArg, '..'));
      return n;
    }
    const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv']);
    const walk = (d: string, depth: number): void => {
      if (depth < 0) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p, depth - 1);
        else if (isDoc(e.name)) ingest(p, d);
        if (n > 800) return;
      }
    };
    walk(pathArg, 6);
    return n;
  }

  /** Reference ONE skill unit. The skill is NEVER moved or copied: it stays
   *  at its original path (the source of truth). Ateam only stores metadata
   *  (the .index record) plus a symlink in the vault POINTING AT the
   *  original — so the vault holds knowledge/experience, never skill files,
   *  and in-session edits land directly on the user's real skill. Idempotent.
   *  Returns 1 on success. */
  importSkillUnit(
    agentKey: string,
    unitPath: string,
    kind: 'file' | 'bundle' | 'tree',
    entry: string,
    scope: Scope = 'global',
    projectId?: string,
  ): number {
    if (!existsSync(unitPath)) return 0;
    const name = basename(unitPath).replace(/\.(md|mdc|markdown|mdx)$/i, '');
    const slug = slugify(name);
    const real = (p: string): string => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const ah = real(ateamHome());
    const entryFile = kind === 'file' ? basename(unitPath) : entry;
    const slugDir = this.store.skillContentDir(agentKey, scope, slug, projectId);
    // for a dir unit the vault entry IS the symlink; for a file unit it is a
    // dir holding one symlink named after the file (keeps join(dest,entry)).
    const dest = slugDir;
    const linkPath = kind === 'file' ? join(slugDir, entryFile) : slugDir;

    // Legacy-state guard: if the original is itself a symlink into the vault
    // (left by the old move-and-replace model), don't relink — that would
    // loop. Treat the resolved vault content as the bundle and just record.
    const originReal = real(unitPath);
    const legacyInVault = originReal.startsWith(ah);

    if (!legacyInVault) {
      try {
        if (kind === 'file') mkdirSync(slugDir, { recursive: true });
        else mkdirSync(join(slugDir, '..'), { recursive: true });
        let cur: ReturnType<typeof lstatSync> | null = null;
        try {
          cur = lstatSync(linkPath);
        } catch {
          /* not present yet */
        }
        const correct = cur?.isSymbolicLink() && real(linkPath) === originReal;
        if (!correct) {
          // replace a stale link OR a real copy left by the old model (the
          // original is intact in this model, so dropping the copy is safe)
          if (cur) rmSync(linkPath, { recursive: true, force: true });
          symlinkSync(unitPath, linkPath, kind === 'file' ? 'file' : 'dir');
        }
      } catch {
        /* best-effort: metadata below still records originalPath */
      }
    }

    const entryAbs = legacyInVault
      ? kind === 'file'
        ? originReal
        : join(originReal, entryFile)
      : join(dest, entryFile);
    let body = '';
    try {
      if (existsSync(entryAbs)) body = readFileSync(entryAbs, 'utf8');
    } catch {
      /* entry unreadable */
    }
    const fm = frontmatter(body);
    this.store.saveSkill({
      agentKey,
      scope,
      projectId,
      kind: 'skill',
      domain: fm.domain ?? name,
      name: fm.title ?? name,
      description: skillCapability(body, fm) || `skill: ${fm.title ?? name}`,
      body: body || `(skill: ${name})`,
      source: 'user_provided',
      tags: fm.tags ?? [],
      bundlePath: legacyInVault ? originReal : dest,
      entryFile,
      originalPath: unitPath,
    });
    return 1;
  }

  /** Reverse of importSkillUnit: drop every skill record this Human has whose
   *  `originalPath` equals unitPath, and best-effort remove the per-human
   *  vault symlink/dir. Returns the number of skill records removed. */
  unassignSkillUnit(agentKey: string, unitPath: string): number {
    const matches = this.store
      .allSkills()
      .filter((s) => s.agentKey === agentKey && s.originalPath === unitPath);
    for (const m of matches) {
      // remove the vault symlink/dir (bundlePath is the per-human slug dir
      // populated by importSkillUnit). Best-effort — store delete still
      // proceeds even if the link is missing/broken.
      if (m.bundlePath?.startsWith(ateamHome())) {
        try {
          rmSync(m.bundlePath, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      this.store.deleteSkill(m.id);
    }
    return matches.length;
  }

  /** ② distill ≥3 same-domain experiences of a human into one Skill, and
   *  ④ reinforce the contributing experiences (they proved reusable). */
  async distillDomain(
    agentKey: string,
    domain: string,
    minCount = 3,
    scope: Scope = 'global',
  ): Promise<StoredExperience[] | null> {
    const exps = this.store
      .listExperiences({ agentKey, domain })
      .filter((e) => !!e.lessonLearned || !!e.generalization);
    if (exps.length < minCount) return null;
    const d = await this.synth.distillSkill(
      domain,
      exps.map((e) => ({
        title: e.title,
        lessonLearned: e.lessonLearned,
        generalization: e.generalization,
      })),
    );
    this.store.saveSkill({
      agentKey,
      scope,
      kind: 'skill',
      domain: d.domain || domain,
      name: d.name,
      description: d.description || `distilled from ${exps.length} experiences`,
      body: d.body,
      source: 'distilled',
      tags: d.tags,
    });
    for (const e of exps) this.store.markApplied(e.id); // ④ they were reused
    return exps;
  }

  /** F-Role-02: learn reusable skills/knowledge by scanning a project. */
  async learnFromProject(
    agentKey: string,
    projectDir: string,
    scope: Scope = 'global',
    projectId?: string,
  ): Promise<number> {
    const items = await this.synth.learnFromRepo(projectDir);
    for (const it of items) {
      this.store.saveSkill({
        agentKey,
        scope,
        projectId,
        kind: it.kind,
        domain: it.domain,
        name: it.name,
        description: it.description,
        body: it.body,
        source: 'learned',
        tags: it.tags,
      });
    }
    return items.length;
  }
}
