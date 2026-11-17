import { describe, expect, it } from 'vitest';
import { imageFilesFrom, pastedName } from './pasteImages';

const file = (name: string, type: string): File =>
  new File([new Uint8Array([1, 2, 3])], name, { type });
const item = (f: File | null, kind = 'file') => ({ kind, type: f?.type ?? '', getAsFile: () => f });

describe('imageFilesFrom', () => {
  it('takes a screenshot from the clipboard items', () => {
    const shot = file('image.png', 'image/png');
    expect(imageFilesFrom({ items: [item(shot)] })).toEqual([shot]);
  });

  it('ignores the text a copy carries alongside', () => {
    const shot = file('image.png', 'image/png');
    expect(imageFilesFrom({ items: [item(null, 'string'), item(shot)] })).toEqual([shot]);
  });

  it('pastes nothing for plain text — xterm and the textarea keep that', () => {
    expect(imageFilesFrom({ items: [item(null, 'string')] })).toEqual([]);
    expect(imageFilesFrom(null)).toEqual([]);
  });

  it('skips files that are not pictures', () => {
    expect(imageFilesFrom({ items: [item(file('notes.pdf', 'application/pdf'))] })).toEqual([]);
  });

  it('falls back to files, and never counts one picture twice', () => {
    const shot = file('a.png', 'image/png');
    expect(imageFilesFrom({ items: [], files: [shot] })).toEqual([shot]);
    expect(imageFilesFrom({ items: [item(shot)], files: [shot] })).toEqual([shot]);
  });
});

describe('pastedName', () => {
  const at = new Date('2026-09-13T10:20:30Z');
  it('stamps a screenshot, which always arrives as image.png', () => {
    expect(pastedName({ name: 'image.png', type: 'image/png' }, at)).toBe(
      'paste-20260913102030.png',
    );
    expect(pastedName({ name: '', type: 'image/jpeg' }, at)).toBe('paste-20260913102030.jpg');
  });
  it('keeps a real file name', () => {
    expect(pastedName({ name: 'mockup-v2.png', type: 'image/png' }, at)).toBe('mockup-v2.png');
  });
});
