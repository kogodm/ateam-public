import { describe, expect, it } from 'vitest';
import { modelShortName } from './StreamView';

describe('the model label shown in the stream', () => {
  it('keeps the family and the version', () => {
    expect(modelShortName('claude-fable-5-1')).toBe('fable 5.1');
    expect(modelShortName('claude-opus-5')).toBe('opus 5');
    expect(modelShortName('claude-sonnet-4-6')).toBe('sonnet 4.6');
    expect(modelShortName('claude-haiku-4-5-20251001')).toBe('haiku 4.5');
    expect(modelShortName('claude-mythos-5-1')).toBe('mythos 5.1');
  });

  it('shows an id it does not recognise as it is, minus the vendor prefix', () => {
    expect(modelShortName('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(modelShortName('claude-something-new')).toBe('something-new');
  });
});
