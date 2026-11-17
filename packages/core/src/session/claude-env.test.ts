import { describe, expect, it } from 'vitest';
import {
  CLAUDE_PROCESS_MARKERS,
  inheritedClaudeMarkers,
  stripClaudeProcessMarkers,
} from './claude-env';

describe('stripClaudeProcessMarkers', () => {
  it('removes every marker a parent claude exports', () => {
    const dirty = Object.fromEntries(CLAUDE_PROCESS_MARKERS.map((k) => [k, 'x']));
    expect(Object.keys(stripClaudeProcessMarkers(dirty))).toEqual([]);
  });

  it('keeps everything a session actually needs', () => {
    // same CLAUDE_/ANTHROPIC_ prefixes — which is why this is a list and not
    // a wildcard sweep. Losing these breaks auth, the config dir, and the
    // app's own per-PTY tags.
    const keep = {
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      CLAUDE_CONFIG_DIR: '/home/me/.claude',
      CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0',
      ATEAM_SESSION: 's1',
      ATEAM_HOME: '/home/me/.ateam',
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    };
    expect(stripClaudeProcessMarkers({ ...keep, CLAUDECODE: '1' })).toEqual(keep);
  });

  it('does not mutate the environment it was handed', () => {
    const src = { CLAUDECODE: '1', PATH: '/usr/bin' };
    stripClaudeProcessMarkers(src);
    expect(src.CLAUDECODE).toBe('1');
  });
});

describe('inheritedClaudeMarkers', () => {
  it('names what is being carried, so a log line can say it', () => {
    expect(
      inheritedClaudeMarkers({
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_PID: '42',
        PATH: '/usr/bin',
      }),
    ).toEqual(['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']);
  });

  it('is empty for a clean environment — an empty value is not a marker', () => {
    expect(inheritedClaudeMarkers({ PATH: '/usr/bin', CLAUDECODE: '' })).toEqual([]);
  });
});
