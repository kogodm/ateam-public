import type { TuiPicker } from './tuiPicker';

export function modelMenuAnchor(
  rect: { right: number; top: number },
  width: number,
  height: number,
) {
  const panelWidth = Math.min(360, width - 16);
  return {
    right: Math.min(Math.max(8, width - panelWidth - 8), Math.max(8, width - rect.right)),
    bottom: Math.max(8, height - rect.top + 8),
    maxHeight: Math.max(100, Math.min(480, rect.top - 16)),
  };
}

export function isModelPicker(picker: TuiPicker | null): boolean {
  if (!picker) return false;
  const title = picker.title ?? '';
  if (/permission|access|approve|command|trust/i.test(title)) return false;
  return (
    /(?:select|choose|switch|change).*model|reasoning|effort|more models|available models|models matching\b|edit parameters/i.test(
      title,
    ) ||
    picker.options.filter((option) =>
      /^(?:gpt-|Auto\b|Composer\b|Grok\b|Gemini\b|Muse\b|Opus\b|Sonnet\b|Haiku\b|Fable\b|Mythos\b|Claude\b)/i.test(
        option.label,
      ),
    ).length >= 2
  );
}
