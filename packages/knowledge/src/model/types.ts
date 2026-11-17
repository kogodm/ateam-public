/**
 * The 3D x 2D asset model — the data the self-evolution flywheel mutates.
 * All types are immutable (readonly); the store owns timestamps/versioning.
 * Faithful to architecture doc §5, with gap decisions called out inline.
 */

export type AssetScope = 'project' | 'global';
export type AssetKind = 'knowledge' | 'skill' | 'experience';

/** GAP: embedding is NOT on the domain object (index concern). Status only. */
export type EmbeddingStatus = 'pending' | 'ready' | 'stale' | 'failed';

/** GAP: ISO-8601 strings, not Date (avoids TZ drift on Markdown round-trip). */
export type IsoTimestamp = string;

/** GAP: confidence is a tagged value so decay is auditable (growth report). */
export type ConfidenceBasis =
  | 'declared'
  | 'single_project'
  | 'multi_project'
  | 'user_asserted';

export interface Confidence {
  /** 0..1 */
  readonly value: number;
  readonly basis: ConfidenceBasis;
  readonly last_recomputed: IsoTimestamp;
}

/** Stable cross-reference (`@knowledge/<slug>` etc.). */
export interface AssetRef {
  readonly kind: AssetKind;
  readonly slug: string;
  /** resolved at index time; absent until linked */
  readonly id?: string;
}

export interface ScopedAsset {
  readonly id: string; // ULID
  readonly slug: string; // == markdown filename stem
  readonly kind: AssetKind;
  readonly scope: AssetScope;
  readonly agent_id: string;
  readonly user_id: string;
  readonly project_id?: string; // iff scope === 'project'
  readonly source_projects?: readonly string[]; // iff scope === 'global'
  readonly domain: string;
  readonly tags: readonly string[];
  readonly embedding_status: EmbeddingStatus;
  readonly content_hash: string; // sha256 of canonical body
  readonly created_at: IsoTimestamp;
  readonly updated_at: IsoTimestamp;
  readonly schema_version: number;
}

export type KnowledgeType = 'concept' | 'reference' | 'spec' | 'guide';

export interface Knowledge extends ScopedAsset {
  readonly kind: 'knowledge';
  readonly title: string;
  readonly content: string;
  readonly summary: string;
  readonly knowledge_type: KnowledgeType;
  readonly project_context?: string;
  readonly abstraction_level?: 'concrete' | 'general' | 'principle';
  readonly source: {
    readonly type: 'user_provided' | 'project_learned' | 'doc_imported';
    readonly project_id?: string;
    readonly source_url?: string;
    readonly learned_at: IsoTimestamp;
  };
  readonly confidence: Confidence;
  readonly last_verified: IsoTimestamp;
  readonly version: number;
}

export interface SkillStep {
  readonly order: number;
  readonly action: string;
  readonly detail: string;
  readonly code_ref?: string;
  readonly common_pitfalls?: readonly string[];
}

export type Proficiency = 'declared' | 'practiced' | 'mastered';

/** GAP: derived stats are store-owned; `proficiency` is a pure fn of these. */
export interface SkillStats {
  readonly applied_count: number;
  readonly success_count: number;
  readonly failure_count: number;
  readonly last_applied_at?: IsoTimestamp;
}

export interface Skill extends ScopedAsset {
  readonly kind: 'skill';
  readonly name: string;
  readonly description: string;
  readonly workflow: {
    readonly steps: readonly SkillStep[];
    readonly prerequisites: readonly string[];
    readonly inputs: readonly { readonly name: string; readonly type: string; readonly required: boolean }[];
    readonly outputs: readonly { readonly name: string; readonly type: string }[];
  };
  readonly code_templates: readonly {
    readonly name: string;
    readonly language: string;
    readonly code: string;
    readonly when_to_use: string;
  }[];
  readonly checklists: readonly { readonly name: string; readonly items: readonly string[] }[];
  readonly related_knowledge: readonly AssetRef[];
  readonly derived_from_experiences: readonly AssetRef[];
  readonly proficiency: Proficiency;
  readonly project_dependencies?: readonly string[];
  readonly cross_project_applications?: readonly {
    readonly project_id: string;
    readonly success: boolean;
    readonly notes: string;
    readonly applied_at: IsoTimestamp;
  }[];
  readonly stats: SkillStats;
  readonly confidence: Confidence;
  readonly source: {
    readonly type:
      | 'user_provided'
      | 'distilled_from_experience'
      | 'crystallized_from_knowledge';
    readonly notes?: string;
  };
}

export interface Experience extends ScopedAsset {
  readonly kind: 'experience';
  readonly title: string;
  readonly narrative: string;
  readonly context: {
    readonly project_id: string;
    readonly task: string;
    readonly tech_stack: readonly string[];
    /** GAP: which workspace this happened in (multi-dir projects) */
    readonly workspace_id?: string;
  };
  readonly what_happened: string;
  readonly what_i_did: string;
  readonly outcome: string;
  readonly lesson_learned: string;
  readonly generalization: string; // promotion key
  readonly related_experiences: readonly AssetRef[];
  readonly contributes_to_skills: readonly AssetRef[];
  readonly references_knowledge: readonly AssetRef[];
  readonly emotional_weight: 'painful' | 'neutral' | 'satisfying';
  readonly confidence: Confidence;
  readonly applied_count: number;
  /** GAP: HYBRID sinking model — auto/incident vs user-reviewed/methodology */
  readonly capture: {
    readonly mode: 'auto' | 'user_reviewed';
    readonly level: 'incident' | 'methodology';
    readonly reviewed_at?: IsoTimestamp;
  };
  readonly raw_context?: {
    readonly task: string;
    readonly files_involved: readonly string[];
    readonly commit_hash?: string;
  };
  readonly applicable_when?: readonly string[];
  /** GAP: promotion lineage for traceback */
  readonly promoted_from?: {
    readonly project_asset_id: string;
    readonly promoted_at: IsoTimestamp;
    readonly desensitized: boolean;
  };
}

export interface AgentIdentity {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly user_id: string;
  readonly joined_at: IsoTimestamp;
  readonly system_prompt_template: string;
  readonly provider: {
    readonly type: 'claude-oauth' | 'codex-oauth' | 'custom';
    readonly model?: string;
    readonly base_url?: string;
    readonly api_key_ref?: string;
  };
  readonly tools: {
    readonly allowed: readonly string[];
    readonly workspace_access: 'read' | 'write' | 'admin';
  };
  readonly can_talk_to: readonly string[];
  readonly profile: {
    readonly total_projects: number;
    readonly total_experiences: number;
    readonly total_skills: number;
    readonly total_knowledge: number;
    readonly domain_expertise: readonly {
      readonly domain: string;
      readonly level: 'intermediate' | 'senior' | 'expert';
      readonly score: number;
    }[];
  };
}

export interface ProjectArchive {
  readonly project_id: string;
  readonly user_id: string;
  readonly name: string;
  readonly user_tags: readonly string[];
  readonly user_links: readonly string[];
  readonly user_description: string;
  /** multi-dir projects: workspace ids belonging to this project */
  readonly workspace_ids: readonly string[];
  readonly tech_stack: {
    readonly language: readonly string[];
    readonly framework: readonly string[];
    readonly infra: readonly string[];
    readonly third_party_apis: readonly string[];
  };
  readonly status: 'active' | 'completed' | 'archived';
  readonly is_private: boolean;
  readonly created_at: IsoTimestamp;
  readonly archived_at?: IsoTimestamp;
}

export interface RoleTemplate {
  readonly role: string;
  readonly display_name: string;
  readonly default_system_prompt: string;
  readonly default_tools: readonly string[];
  readonly default_domains: readonly string[];
  readonly seed_knowledge?: readonly AssetRef[];
}
