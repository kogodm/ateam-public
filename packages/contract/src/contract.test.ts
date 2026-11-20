import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  parseEnvelope,
  validateEventData,
  validateParams,
} from './index';
import { EXTERNAL_TOOLS } from './external-tools';

describe('envelope round-trip', () => {
  it('accepts a valid req', () => {
    const msg = {
      v: PROTOCOL_VERSION,
      kind: 'req',
      id: 'r1',
      method: 'session.list',
      params: {},
    };
    expect(parseEnvelope(JSON.parse(JSON.stringify(msg)))).toEqual(msg);
  });

  it('accepts a valid evt with corr + seq', () => {
    const msg = {
      v: PROTOCOL_VERSION,
      kind: 'evt',
      topic: 'session.output',
      corr: 'r1',
      seq: 3,
      data: { sessionId: 's1', chunk: 'hello' },
    };
    expect(parseEnvelope(JSON.parse(JSON.stringify(msg)))).toEqual(msg);
  });

  it('accepts an error response', () => {
    const msg = {
      v: PROTOCOL_VERSION,
      kind: 'res',
      id: 'r1',
      ok: false,
      error: { code: 'not_found', message: 'no such session' },
    };
    expect(parseEnvelope(msg)).toEqual(msg);
  });

  it('rejects a mismatched protocol version', () => {
    expect(() => parseEnvelope({ v: 999, kind: 'req', id: 'x', method: 'm', params: {} })).toThrow(
      ProtocolValidationError,
    );
  });

  it('rejects an unknown kind', () => {
    expect(() => parseEnvelope({ v: PROTOCOL_VERSION, kind: 'nope' })).toThrow(
      ProtocolValidationError,
    );
  });
});

describe('validateParams', () => {
  it('accepts Cursor Desktop as an external MCP registration client', () => {
    expect(validateParams('externalMcp.register', { client: 'cursor-desktop' })).toEqual({
      client: 'cursor-desktop',
    });
    expect(() => validateParams('externalMcp.register', { client: 'unknown' })).toThrow(
      ProtocolValidationError,
    );
  });

  it('accepts valid session.spawn params', () => {
    const params = {
      agentName: '小明',
      role: 'coder',
      workspace: { id: 'w1', name: 'web', root: '/tmp/web' },
    };
    expect(validateParams('session.spawn', params)).toMatchObject(params);
  });

  it('accepts session.spawn without workspace (directory-less: talk to a human)', () => {
    const params = { agentName: 'a', role: 'coder', directoryless: true };
    expect(validateParams('session.spawn', params)).toMatchObject(params);
  });

  it('preserves Cursor provider ids across spawn, state, handoff, and provider switching', () => {
    const spawn = { agentName: 'Cursor', role: 'coder', providerId: 'cursor' };
    expect(validateParams('session.spawn', spawn)).toEqual(spawn);

    const agent = {
      projectName: 'p',
      agentName: 'Cursor',
      role: 'coder',
      dir: '/x',
      claudeSessionId: 'id',
      providerId: 'cursor',
    };
    expect(validateParams('sessionState.set', { agents: [agent] })).toEqual({ agents: [agent] });
    expect(
      validateParams('session.handoffNow', { sessionId: 's', successorProviderId: 'cursor' }),
    ).toEqual({ sessionId: 's', successorProviderId: 'cursor' });
    expect(
      validateParams('session.switchProvider', { sessionId: 's', targetProviderId: 'cursor' }),
    ).toEqual({ sessionId: 's', targetProviderId: 'cursor' });
  });

  it('preserves Antigravity provider ids across spawn, handoff, and provider switching', () => {
    const spawn = { agentName: 'Agy', role: 'coder', providerId: 'antigravity' as const };
    expect(validateParams('session.spawn', spawn)).toEqual(spawn);
    expect(
      validateParams('session.handoffNow', {
        sessionId: 's',
        successorProviderId: 'antigravity',
      }),
    ).toEqual({ sessionId: 's', successorProviderId: 'antigravity' });
    expect(
      validateParams('session.switchProvider', {
        sessionId: 's',
        targetProviderId: 'antigravity',
      }),
    ).toEqual({ sessionId: 's', targetProviderId: 'antigravity' });
  });

  it('rejects session.spawn missing required agentName', () => {
    expect(() => validateParams('session.spawn', { role: 'coder' })).toThrow(
      ProtocolValidationError,
    );
  });

  it('accepts skill.adoptHumanDirs sweep params', () => {
    expect(validateParams('skill.adoptHumanDirs', { all: true })).toMatchObject({ all: true });
  });

  it('accepts human.summarize { id } and rejects empty', () => {
    expect(validateParams('human.summarize', { id: 'x' })).toEqual({ id: 'x' });
    expect(() => validateParams('human.summarize', {})).toThrow(ProtocolValidationError);
  });

  it("takes an empty app.openPath appName — that is the OS's own default handler", () => {
    expect(validateParams('app.openPath', { appName: '', path: '/a/b.png' })).toMatchObject({
      appName: '',
      path: '/a/b.png',
    });
    expect(() => validateParams('app.openPath', { appName: 'Preview', path: '' })).toThrow(
      ProtocolValidationError,
    );
  });

  it('accepts avatarId in human.update patch', () => {
    const p = { id: 'x', patch: { avatarId: 'a1' } };
    expect(validateParams('human.update', p)).toMatchObject(p);
  });

  it('keeps providerId on persisted agents (sessionState.set) and handoff/addHibernated params', () => {
    const agent = {
      projectName: 'p',
      agentName: 'a',
      role: 'coder',
      dir: '/x',
      claudeSessionId: 'id',
      providerId: 'codex' as const,
    };
    // zod strips unknown keys — a missing schema field silently drops the
    // runtime and the session comes back as claude on restore.
    expect(validateParams('sessionState.set', { agents: [agent] })).toEqual({ agents: [agent] });
    expect(validateParams('session.addHibernated', agent)).toMatchObject({ providerId: 'codex' });
    expect(
      validateParams('session.handoffNow', { sessionId: 's', successorProviderId: 'codex' }),
    ).toMatchObject({ successorProviderId: 'codex' });
    expect(
      validateParams('session.switchProvider', { sessionId: 's', targetProviderId: 'codex' }),
    ).toEqual({ sessionId: 's', targetProviderId: 'codex' });
  });

  it('passes through reserved (not-yet-validated) methods', () => {
    const p = { anything: true };
    expect(validateParams('project.start', p)).toBe(p);
  });

  it('validates the external execution history query params', () => {
    expect(validateParams('session.externalRuns', { sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1',
    });
    expect(() => validateParams('session.externalRuns', {})).toThrow(ProtocolValidationError);
    expect(() => validateParams('session.externalRuns', { sessionId: '' })).toThrow(
      ProtocolValidationError,
    );
  });
});

describe('shared external tools', () => {
  it('defines Cursor install as an execute-authorized project-only action', () => {
    const tool = EXTERNAL_TOOLS.find((candidate) => candidate.name === 'install_cursor_cli');
    expect(tool?.inputSchema.required).toEqual(['project_id']);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['project_id']);
    expect(tool?.description).not.toMatch(/https?:\/\/|shell|command line/i);
  });
});

describe('validateEventData', () => {
  it('accepts valid session.status', () => {
    const d = { sessionId: 's1', state: 'running' };
    expect(validateEventData('session.status', d)).toMatchObject(d);
  });

  it('rejects an invalid session.status state', () => {
    expect(() => validateEventData('session.status', { sessionId: 's1', state: 'weird' })).toThrow(
      ProtocolValidationError,
    );
  });

  it('preserves the injected-turn marker on live session.turn events', () => {
    const data = {
      sessionId: 's1',
      turn: {
        seq: 3,
        sessionId: 's1',
        role: 'user',
        text: 'handoff prompt',
        at: '2026-10-15T12:00:00.000Z',
        injected: 'handoff',
      },
    };
    expect(validateEventData('session.turn', data)).toMatchObject(data);
    const compacted = { ...data, turn: { ...data.turn, injected: 'compaction' } };
    expect(validateEventData('session.turn', compacted)).toMatchObject(compacted);
  });

  it('validates standalone external execution events separately from transcript turns', () => {
    const run = {
      executionId: 'execution-1',
      sessionId: 'session-1',
      tool: 'run_command',
      command: 'echo hello',
      status: 'exited',
      exitCode: 0,
      startedAt: '2026-10-15T12:00:00.000Z',
      endedAt: '2026-10-15T12:00:01.000Z',
      output: 'hello\n',
      truncated: false,
    };
    const data = { sessionId: 'session-1', run };
    expect(validateEventData('session.externalRun', data)).toEqual(data);
    expect(() => validateEventData('session.externalRun', { run })).toThrow(
      ProtocolValidationError,
    );
    expect(() =>
      validateEventData('session.externalRun', {
        sessionId: 'session-1',
        run: { ...run, sessionId: undefined },
      }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      validateEventData('session.externalRun', {
        sessionId: 'session-1',
        run: { ...run, executionId: undefined },
      }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      validateEventData('session.externalRun', {
        sessionId: 'session-1',
        run: { ...run, status: 'queued' },
      }),
    ).toThrow(ProtocolValidationError);
  });
});
