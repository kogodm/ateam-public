/**
 * The LLM seam. The knowledge package never imports a Provider/CLI; whoever
 * wires the flywheel injects an implementation (M2: a `claude -p` impl in
 * @ateam/core). This keeps the dependency direction clean.
 */
export interface ExperienceDraft {
  domain: string;
  title: string;
  narrative: string;
  lessonLearned: string;
  generalization: string;
  tags: string[];
  techStack: string[];
}

export type ReflectionKind = 'experience' | 'knowledge' | 'skill';

/**
 * One genuinely-valuable thing distilled from a session. A reflection may
 * yield ZERO of these (nothing worth keeping) — the LLM judges value, e.g.
 * a model misunderstanding the user corrected, an implementation approach,
 * explicit reusable knowledge, or something with skill potential (the list
 * is not exhaustive; the model decides).
 */
export interface ReflectionItem {
  kind: ReflectionKind;
  domain: string;
  /** experience: a short title · knowledge/skill: the name */
  title: string;
  /** experience: the narrative · knowledge/skill: the body markdown */
  body: string;
  /** experience only */
  lessonLearned?: string;
  generalization?: string;
  /** knowledge/skill: one-line capability blurb */
  description?: string;
  tags: string[];
  techStack?: string[];
  /** Knowledge/skill only: replace an existing VAULT-ONLY record with this
   *  title (no source files / no bundlePath) instead of creating a new one.
   *  Ignored for experiences (append-only) and for skills with a bundlePath
   *  (those are updated in-place at the source by the in-session path). */
  updateOf?: string;
}

export interface LearnedItem {
  kind: 'skill' | 'knowledge';
  domain: string;
  name: string;
  description: string;
  body: string;
  tags: string[];
}

export interface DistilledSkill {
  name: string;
  domain: string;
  description: string;
  body: string;
  tags: string[];
}

export interface LlmSynthesizer {
  /** Reflect over (incremental) transcript text. Returns only genuinely
   *  valuable items — possibly an empty array (nothing worth keeping). */
  reflect(transcript: string, hint?: { domain?: string }): Promise<ReflectionItem[]>;
  /** Explore a repository and extract reusable Skills/Knowledge (F-Role-02). */
  learnFromRepo(projectDir: string): Promise<LearnedItem[]>;
  /** ② distill several same-domain experiences into one reusable Skill. */
  distillSkill(
    domain: string,
    experiences: { title: string; lessonLearned: string; generalization: string }[],
  ): Promise<DistilledSkill>;
}
