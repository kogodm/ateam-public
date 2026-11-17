import { describe, expect, it } from 'vitest';
import { loadDraft, saveDraft } from './streamDrafts';

describe('stream drafts', () => {
  it('keeps an unsent message across a session switch', () => {
    saveDraft('a', { text: 'half written', attachments: [{ path: '/x.png', url: 'blob:1' }] });
    saveDraft('b', { text: 'other', attachments: [] });
    expect(loadDraft('a')).toEqual({
      text: 'half written',
      attachments: [{ path: '/x.png', url: 'blob:1' }],
    });
    saveDraft('a', { text: '', attachments: [] }); // sent
    expect(loadDraft('a')).toEqual({ text: '', attachments: [] });
    expect(loadDraft('b').text).toBe('other');
  });
});
