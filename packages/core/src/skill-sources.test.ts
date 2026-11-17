import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetStore } from '@ateam/knowledge';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeSynthesizer } from './flywheel/claude-synth';
import { Flywheel } from './flywheel/flywheel';
import { assignSkillUnit } from './skill-assignments';
import { discoverSkillSources, discoverSkillUnits, isDoc } from './skill-sources';

describe('skill source discovery', () => {
  const prevHome = process.env.HOME;
  const prevAteam = process.env.ATEAM_HOME;
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAteam === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevAteam;
  });

  it('isDoc recognizes md/mdc + known bare names', () => {
    expect(isDoc('rules.md')).toBe(true);
    expect(isDoc('a.mdc')).toBe(true);
    expect(isDoc('CLAUDE.md')).toBe(true);
    expect(isDoc('.cursorrules')).toBe(true);
    expect(isDoc('image.png')).toBe(false);
  });

  it('discovers cwd + global claude/cursor/codex locations', () => {
    const home = mkdtempSync(join(tmpdir(), 'ateam-home-'));
    mkdirSync(join(home, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(home, '.claude', 'rules', 'style.md'), '# style');
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# global');
    mkdirSync(join(home, '.cursor', 'rules'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'rules', 'r.mdc'), 'rule');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'AGENTS.md'), '# codex');
    process.env.HOME = home;

    const cwd = mkdtempSync(join(tmpdir(), 'ateam-proj-'));
    writeFileSync(join(cwd, 'CLAUDE.md'), '# project');

    const srcs = discoverSkillSources(cwd);
    const origins = new Set(srcs.map((s) => s.origin));
    expect(origins.has('global-claude')).toBe(true);
    expect(origins.has('global-cursor')).toBe(true);
    expect(origins.has('global-codex')).toBe(true);
    expect(origins.has('project')).toBe(true);
    expect(srcs.find((s) => s.origin === 'global-claude' && s.label === 'rules/')?.count).toBe(1);
  });

  it('discovers skill units (bundles vs trees) with assignment markers, preserves tree on import', () => {
    const home = mkdtempSync(join(tmpdir(), 'ateam-home-'));
    process.env.HOME = home;
    process.env.ATEAM_HOME = join(home, '.ateam');
    // ~/.claude/skills/<name>/SKILL.md  -> a bundle unit per skill
    mkdirSync(join(home, '.claude', 'skills', 'wxpay', 'scripts'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'skills', 'wxpay', 'SKILL.md'),
      '# wxpay\nsee scripts/sign.md',
    );
    writeFileSync(join(home, '.claude', 'skills', 'wxpay', 'scripts', 'sign.md'), '# sign helper');
    // ~/.claude/rules/  -> ONE tree unit (cross-refs across subdirs)
    mkdirSync(join(home, '.claude', 'rules', 'python'), { recursive: true });
    writeFileSync(join(home, '.claude', 'rules', 'common.md'), '# common');
    writeFileSync(join(home, '.claude', 'rules', 'python', 'style.md'), 'extends ../common.md');

    const cwd = mkdtempSync(join(tmpdir(), 'ateam-proj-'));
    const units = discoverSkillUnits(cwd);
    const bundle = units.find((u) => u.kind === 'bundle' && u.label.includes('wxpay'));
    const tree = units.find((u) => u.kind === 'tree' && u.label === 'rules/');
    expect(bundle).toBeTruthy();
    expect(tree).toBeTruthy();

    // assignment marker shows up after assigning
    assignSkillUnit(bundle?.path ?? '', 'h1', '小明');
    const again = discoverSkillUnits(cwd);
    expect(again.find((u) => u.path === bundle?.path)?.assignedTo.map((a) => a.humanName)).toEqual([
      '小明',
    ]);

    // import the bundle -> structure (scripts/sign.md) preserved
    const root = mkdtempSync(join(tmpdir(), 'ateam-st-'));
    const store = new AssetStore(root);
    const fw = new Flywheel(store, new ClaudeSynthesizer());
    expect(fw.importSkillUnit('h1', bundle?.path ?? '', 'bundle', 'SKILL.md', 'global')).toBe(1);
    const sk = store.listSkills({ agentKey: 'h1' })[0];
    expect(sk?.bundlePath).toBeTruthy();
    expect(sk?.bundlePath?.includes('_bundles')).toBe(false);
    const orig = bundle?.path ?? '';
    // NEW model: the skill is NOT moved — the original stays a real dir…
    expect(lstatSync(orig).isSymbolicLink()).toBe(false);
    expect(existsSync(join(orig, 'scripts', 'sign.md'))).toBe(true);
    // …and the vault holds ONLY a symlink pointing back at the original
    expect(lstatSync(sk?.bundlePath ?? '').isSymbolicLink()).toBe(true);
    expect(realpathSync(sk?.bundlePath ?? '')).toBe(realpathSync(orig));
    // reads through the vault symlink resolve to the real skill, structure kept
    expect(existsSync(join(sk?.bundlePath ?? '', 'scripts', 'sign.md'))).toBe(true);
    expect(readFileSync(join(sk?.bundlePath ?? '', 'SKILL.md'), 'utf8')).toContain(
      'scripts/sign.md',
    );
    // editing the ORIGINAL is what Ateam sees (vault just references it)
    writeFileSync(join(orig, 'SKILL.md'), '# wxpay v2\nsee scripts/sign.md');
    expect(readFileSync(join(sk?.bundlePath ?? '', 'SKILL.md'), 'utf8')).toContain('v2');
    expect(sk?.originalPath).toBe(orig);
    // exactly one indexed skill (copied SKILL.md/scripts/*.md NOT re-ingested)
    expect(store.listSkills({ agentKey: 'h1' })).toHaveLength(1);
    expect(new AssetStore(root).listSkills({ agentKey: 'h1' })).toHaveLength(1);
    // per-human 总纲 lists it with its files path
    const man = store.manifestText('h1');
    expect(man).toContain('wxpay');
    expect(man).toContain(sk?.bundlePath ?? 'NONE');
  });

  it('importSkillsFromDir handles a single file and mixed-ext dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'ateam-st-'));
    const store = new AssetStore(root);
    const fw = new Flywheel(store, new ClaudeSynthesizer());

    const oneFile = join(mkdtempSync(join(tmpdir(), 'ateam-f-')), 'CLAUDE.md');
    writeFileSync(oneFile, '# Conventions\nuse tabs');
    expect(fw.importSkillsFromDir('coder', oneFile, 'global')).toBe(1);

    const dir = mkdtempSync(join(tmpdir(), 'ateam-d-'));
    writeFileSync(join(dir, 'a.md'), '# A');
    writeFileSync(join(dir, 'b.mdc'), 'B');
    writeFileSync(join(dir, 'c.png'), 'binary');
    expect(fw.importSkillsFromDir('coder', dir, 'global')).toBe(2);

    expect(store.listSkills({ agentKey: 'coder' })).toHaveLength(3);
  });
});
