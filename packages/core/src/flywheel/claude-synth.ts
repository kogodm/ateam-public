import { spawn } from 'node:child_process';
import type { DistilledSkill, LearnedItem, LlmSynthesizer, ReflectionItem } from '@ateam/knowledge';
import { getPrompt } from '../prompts';
import { resolveClaudeBin } from '../session/claude-bin';
import { logUsage } from '../usage-log';

// Prompts live as plain .txt under packages/core/prompts/ so they can be
// tweaked without touching TS source. `{{LANG_RULE}}` placeholders inside
// each prompt auto-resolve from lang.txt.

function pickJson(s: string): unknown {
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

function pickJsonArray(s: string): unknown[] {
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a === -1 || b <= a) return [];
  try {
    const v = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function str(v: unknown, fb = ''): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fb;
}
function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Pull token/cost from the `claude -p --output-format json` envelope and
 *  append it to ~/.ateam/token-usage.jsonl (best-effort). */
function recordUsage(op: 'reflect' | 'distill' | 'learn', outBuf: string, detail?: string): void {
  const env = pickJson(outBuf) as {
    usage?: Record<string, unknown>;
    total_cost_usd?: unknown;
  } | null;
  const u = env?.usage ?? {};
  logUsage({
    op,
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    costUsd: num(env?.total_cost_usd),
    detail,
  });
}

/**
 * LlmSynthesizer backed by headless `claude -p --output-format json`.
 * Reuses the user's Claude login — no extra credentials. The transcript is
 * fed on stdin (avoids ARG_MAX).
 */
export class ClaudeSynthesizer implements LlmSynthesizer {
  private readonly bin = resolveClaudeBin();

  reflect(transcript: string, hint?: { domain?: string }): Promise<ReflectionItem[]> {
    const input = `${getPrompt('reflect')}${transcript}\n\n(domain hint: ${hint?.domain ?? 'n/a'})`;
    return new Promise<ReflectionItem[]>((resolve) => {
      const child = spawn(this.bin, ['-p', '--output-format', 'json'], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let outBuf = '';
      child.stdout.on('data', (d) => {
        outBuf += String(d);
      });
      // parse failure / crash ⇒ nothing valuable (no fabricated placeholder)
      child.on('error', () => resolve([]));
      child.on('close', () => {
        recordUsage('reflect', outBuf, hint?.domain);
        let resultText = outBuf;
        const outer = pickJson(outBuf) as { result?: unknown } | null;
        if (outer && typeof outer.result === 'string') resultText = outer.result;
        const items = pickJsonArray(resultText)
          .map((x): ReflectionItem | null => {
            const o = x as Record<string, unknown>;
            const kind =
              o.kind === 'knowledge' ? 'knowledge' : o.kind === 'skill' ? 'skill' : 'experience';
            const title = str(o.title) || str(o.name);
            const body = str(o.body) || str(o.narrative);
            if (!title || !body) return null;
            return {
              kind,
              domain: str(o.domain, hint?.domain ?? 'general'),
              title,
              body,
              lessonLearned: str(o.lesson_learned) || undefined,
              generalization: str(o.generalization) || undefined,
              description: str(o.description) || undefined,
              tags: arr(o.tags),
              techStack: arr(o.tech_stack),
              updateOf: kind === 'experience' ? undefined : str(o.update_of) || undefined,
            };
          })
          .filter((v): v is ReflectionItem => v !== null);
        resolve(items);
      });
      child.stdin.end(input);
    });
  }

  learnFromRepo(projectDir: string): Promise<LearnedItem[]> {
    return new Promise<LearnedItem[]>((resolve) => {
      const child = spawn(
        this.bin,
        ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits'],
        { cwd: projectDir, stdio: ['pipe', 'pipe', 'ignore'] },
      );
      let outBuf = '';
      const done = (items: LearnedItem[]): void => resolve(items);
      const timer = setTimeout(() => {
        child.kill();
        done([]);
      }, 180_000);
      child.stdout.on('data', (d) => {
        outBuf += String(d);
      });
      child.on('error', () => {
        clearTimeout(timer);
        done([]);
      });
      child.on('close', () => {
        clearTimeout(timer);
        recordUsage('learn', outBuf, projectDir);
        let resultText = outBuf;
        const outer = pickJson(outBuf) as { result?: unknown } | null;
        if (outer && typeof outer.result === 'string') resultText = outer.result;
        const items = pickJsonArray(resultText)
          .map((x): LearnedItem | null => {
            const o = x as Record<string, unknown>;
            const name = str(o.name);
            if (!name) return null;
            return {
              kind: o.kind === 'knowledge' ? 'knowledge' : 'skill',
              domain: str(o.domain, 'general'),
              name,
              description: str(o.description),
              body: str(o.body),
              tags: arr(o.tags),
            };
          })
          .filter((v): v is LearnedItem => v !== null);
        done(items);
      });
      child.stdin.end(getPrompt('learn'));
    });
  }

  distillSkill(
    domain: string,
    experiences: { title: string; lessonLearned: string; generalization: string }[],
  ): Promise<DistilledSkill> {
    const list = experiences
      .map(
        (e, i) =>
          `${i + 1}. ${e.title}\n   lesson: ${e.lessonLearned}\n   general: ${e.generalization}`,
      )
      .join('\n');
    const input = `${getPrompt('distill', { DOMAIN: domain, COUNT: String(experiences.length) })}${list}`;
    return new Promise<DistilledSkill>((resolve) => {
      const child = spawn(this.bin, ['-p', '--output-format', 'json'], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let outBuf = '';
      const fb = (): DistilledSkill => ({
        name: `${domain} playbook`,
        domain,
        description: `distilled from ${experiences.length} experiences`,
        body: list,
        tags: [domain],
      });
      child.stdout.on('data', (d) => {
        outBuf += String(d);
      });
      child.on('error', () => resolve(fb()));
      child.on('close', () => {
        recordUsage('distill', outBuf, domain);
        let resultText = outBuf;
        const outer = pickJson(outBuf) as { result?: unknown } | null;
        if (outer && typeof outer.result === 'string') resultText = outer.result;
        const j = pickJson(resultText) as Record<string, unknown> | null;
        if (!j) return resolve(fb());
        resolve({
          name: str(j.name, `${domain} playbook`),
          domain: str(j.domain, domain),
          description: str(j.description),
          body: str(j.body, list),
          tags: arr(j.tags),
        });
      });
      child.stdin.end(input);
    });
  }

  /** Best-effort one-paragraph natural-language summary of a human's
   *  accumulated skills/experiences. Returns '' on CLI failure/timeout so the
   *  caller can keep any existing summary. Not part of the LlmSynthesizer
   *  interface (additive). */
  summarize(input: string): Promise<string> {
    const prompt = `${getPrompt('summarize')}${input}`;
    return new Promise<string>((resolve) => {
      const child = spawn(this.bin, ['-p', '--output-format', 'json'], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let outBuf = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve('');
      }, 60_000);
      child.stdout.on('data', (d) => {
        outBuf += String(d);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve('');
      });
      child.on('close', () => {
        clearTimeout(timer);
        recordUsage('distill', outBuf, 'summarize');
        const outer = pickJson(outBuf) as { result?: unknown } | null;
        const text =
          outer && typeof outer.result === 'string' ? outer.result.trim() : outBuf.trim();
        resolve(text.slice(0, 1200));
      });
      child.stdin.end(prompt);
    });
  }

  /** Ask headless claude to find NEW Claude Code skill/plugin marketplaces on
   *  the web (repos exposing `.claude-plugin/marketplace.json`). Returns a list
   *  of `owner/repo` candidates for the app to validate. Best-effort: '' / []
   *  on any failure. Web search is used when the CLI has it; otherwise claude
   *  answers from knowledge and the app's validation still gates what's added. */
  discoverMarketRepos(known: string[]): Promise<string[]> {
    const prompt =
      'Find GitHub repositories that are Claude Code skill or plugin marketplaces — ' +
      'repositories that contain a `.claude-plugin/marketplace.json` file. ' +
      'Use web search if available to find currently popular ones. ' +
      `Exclude these already-known repos: ${known.join(', ') || '(none)'}. ` +
      'Respond with ONLY a JSON array of "owner/repo" strings (max 10, most ' +
      'popular first). No prose, no code fences.';
    return new Promise<string[]>((resolve) => {
      const child = spawn(
        this.bin,
        ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits'],
        { stdio: ['pipe', 'pipe', 'ignore'] },
      );
      let outBuf = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve([]);
      }, 120_000);
      child.stdout.on('data', (d) => {
        outBuf += String(d);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve([]);
      });
      child.on('close', () => {
        clearTimeout(timer);
        recordUsage('distill', outBuf, 'discover');
        const outer = pickJson(outBuf) as { result?: unknown } | null;
        const text =
          outer && typeof outer.result === 'string' ? outer.result : outBuf;
        const a = text.indexOf('[');
        const b = text.lastIndexOf(']');
        if (a === -1 || b <= a) return resolve([]);
        try {
          const arr = JSON.parse(text.slice(a, b + 1)) as unknown[];
          const repos = arr
            .filter((x): x is string => typeof x === 'string')
            .map((s) => s.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, ''))
            .filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s));
          resolve([...new Set(repos)]);
        } catch {
          resolve([]);
        }
      });
      child.stdin.end(prompt);
    });
  }
}
