import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { codegraphEnabled, writeCodegraphMcpConfig } from './codegraph';

describe('codegraph MCP config', () => {
  const prev = process.env.ATEAM_CODEGRAPH;
  afterEach(() => {
    if (prev === undefined) delete process.env.ATEAM_CODEGRAPH;
    else process.env.ATEAM_CODEGRAPH = prev;
  });

  it('is enabled by default, disabled by ATEAM_CODEGRAPH=0', () => {
    delete process.env.ATEAM_CODEGRAPH;
    expect(codegraphEnabled()).toBe(true);
    process.env.ATEAM_CODEGRAPH = '0';
    expect(codegraphEnabled()).toBe(false);
  });

  it('writes a well-formed Claude MCP config for codegraph', () => {
    const path = writeCodegraphMcpConfig('sess-1');
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers: { codegraph: { type: string; command: string; args: string[] } };
    };
    const cg = cfg.mcpServers.codegraph;
    expect(cg.type).toBe('stdio');
    expect(cg.args).toContain('serve');
    expect(cg.args).toContain('--mcp');
    // either a resolved global bin or the npx fallback
    expect(cg.command === 'npx' || cg.command.endsWith('codegraph')).toBe(true);
  });
});
