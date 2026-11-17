import { describe, expect, it } from 'vitest';
import { canSaveLanSettings, isValidLanPort, lanSettingsPatch } from './lanSettings';

describe('LAN settings form helpers', () => {
  it('requires a trimmed four-character password when enabling', () => {
    expect(canSaveLanSettings({ mode: 'enable', password: ' 123 ', port: '4380' }, false)).toBe(false);
    expect(canSaveLanSettings({ mode: 'enable', password: ' 1234 ', port: '4380' }, false)).toBe(true);
  });

  it('allows a blank configure password and omits it to preserve the current one', () => {
    const draft = { mode: 'configure' as const, password: '   ', port: '5000' };
    expect(canSaveLanSettings(draft, false)).toBe(true);
    expect(lanSettingsPatch(draft)).toEqual({ port: 5000 });
  });

  it('accepts only integer ports from 1024 through 65535', () => {
    expect(isValidLanPort('1024')).toBe(true);
    expect(isValidLanPort('65535')).toBe(true);
    expect(isValidLanPort('1023')).toBe(false);
    expect(isValidLanPort('65536')).toBe(false);
    expect(isValidLanPort('4380.5')).toBe(false);
  });
});
