import { describe, expect, it } from 'vitest';
import { listProviders } from './providers';
import { resolveCursorBin } from './session/providers/cursor-adapter';

describe('provider.list', () => {
  it('reports Cursor CLI using the same binary probe as the session adapter', () => {
    const cursor = listProviders().find((provider) => provider.id === 'cursor');
    const resolved = resolveCursorBin();
    expect(cursor).toMatchObject({
      id: 'cursor',
      label: 'Cursor CLI',
      binName: 'cursor-agent',
      runtimeSupported: true,
      available: Boolean(resolved),
    });
    expect(cursor?.path).toBe(resolved);
  });
});
