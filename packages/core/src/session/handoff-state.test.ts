import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupTakenOverDoc,
  finalizeTakeover,
  getHandoffBySuccessor,
  upsertHandoffRecord,
} from './handoff-state';

describe('handoff-state crash safety', () => {
  let home: string;
  let docPath: string;
  const prevHome = process.env.ATEAM_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-home-'));
    process.env.ATEAM_HOME = home;
    docPath = join(home, 'handoff-doc.md');
    writeFileSync(docPath, '# handoff\nwork in progress');
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  const seedTaken = (): void => {
    upsertHandoffRecord({
      oldClaudeSessionId: 'old-1',
      handoffPath: docPath,
      status: 'doc_ready',
      triggeredAt: '2026-01-01T00:00:00Z',
    });
    finalizeTakeover('old-1', {
      sessionId: 'succ-sess',
      claudeSessionId: 'succ-claude',
    });
  };

  it('keeps the handoff doc on disk after takeover (crash-recoverable)', () => {
    seedTaken();
    // The doc MUST survive so an interrupted handoff can be re-injected.
    expect(existsSync(docPath)).toBe(true);
  });

  it('records the successor id and looks it up by successor', () => {
    seedTaken();
    const rec = getHandoffBySuccessor('succ-claude');
    expect(rec?.oldClaudeSessionId).toBe('old-1');
    expect(rec?.status).toBe('taken_over');
    expect(rec?.handoffPath).toBe(docPath);
  });

  it('returns undefined for an unknown successor', () => {
    seedTaken();
    expect(getHandoffBySuccessor('nope')).toBeUndefined();
  });

  it('cleans up the doc only once the successor is confirmed', () => {
    seedTaken();
    cleanupTakenOverDoc('old-1');
    expect(existsSync(docPath)).toBe(false);
    // idempotent — no throw on repeat / missing file
    expect(() => cleanupTakenOverDoc('old-1')).not.toThrow();
    expect(() => cleanupTakenOverDoc('missing')).not.toThrow();
  });
});
