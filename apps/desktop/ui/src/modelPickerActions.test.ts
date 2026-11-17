import { describe, expect, it } from 'vitest';
import { isModelPicker, modelMenuAnchor } from './modelPickerActions';
import { parsePicker } from './tuiPicker';

const rows = [
  'Select Model and Effort',
  '› 1. gpt-6-astra (current)  Frontier',
  '  2. gpt-6.1-sol  Coding',
  'enter select · esc back',
];
describe('Stream model actions', () => {
  it('keeps the full popup inside narrow viewports', () => {
    const mobile = modelMenuAnchor({ right: 345, top: 778 }, 390, 844);
    expect(mobile.right).toBe(22);
    expect(390 - mobile.right - 360).toBeGreaterThanOrEqual(8);
    expect(modelMenuAnchor({ right: 900, top: 600 }, 1000, 700).right).toBe(100);
  });
  it('recognizes model, reasoning and model confirmations but not approvals', () => {
    expect(isModelPicker(parsePicker(rows))).toBe(true);
    for (const title of ['Select reasoning effort', 'Switch model?', 'Advanced Reasoning'])
      expect(isModelPicker({ title, options: [], hint: '' })).toBe(true);
    for (const title of [
      'Update Model Permissions',
      'Would you like to run this command?',
      'Trust this folder?',
    ])
      expect(isModelPicker({ title, options: [], hint: '' })).toBe(false);
  });
});
