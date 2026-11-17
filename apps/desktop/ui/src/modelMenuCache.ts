import type { ProviderId } from '@ateam/contract';
import type { TuiPicker } from './tuiPicker';

export interface ModelOption {
  n: number;
  label: string;
  description?: string;
}
export interface ModelMenu {
  options: ModelOption[];
  at: number;
}
export interface PendingModel extends ModelOption {
  provider: ProviderId;
}
export function cleanModelLabel(label: string): string {
  return label.replace(/(?:\s*(?:\((?:current|default)\)|✔))+\s*$/i, '').trim();
}
export function isModelList(provider: ProviderId, picker: TuiPicker | null): picker is TuiPicker {
  return (
    !!picker &&
    (provider === 'claude'
      ? /select model/i.test(picker.title ?? '')
      : provider === 'codex' && /model and effort/i.test(picker.title ?? ''))
  );
}
export function readModelMenu(
  provider: ProviderId,
  storage?: Pick<Storage, 'getItem'>,
): ModelMenu | null {
  try {
    const menu = JSON.parse(
      (storage ?? localStorage).getItem(`ateam.modelMenu.${provider}`) ?? 'null',
    ) as ModelMenu | null;
    if (
      !menu ||
      !Number.isFinite(menu.at) ||
      !Array.isArray(menu.options) ||
      !menu.options.length ||
      !menu.options.every((o) => Number.isInteger(o.n) && o.n > 0 && typeof o.label === 'string')
    )
      return null;
    return {
      ...menu,
      options: menu.options.map((o) => ({ ...o, label: cleanModelLabel(o.label) })),
    };
  } catch {
    return null;
  }
}
export function cacheModelMenu(
  provider: ProviderId,
  picker: TuiPicker | null,
  storage?: Pick<Storage, 'setItem'>,
): ModelMenu | null {
  if (!isModelList(provider, picker)) return null;
  const menu = {
    options: picker.options.map(({ n, label, description }) => ({
      n,
      label: cleanModelLabel(label),
      description,
    })),
    at: Date.now(),
  };
  try {
    (storage ?? localStorage).setItem(`ateam.modelMenu.${provider}`, JSON.stringify(menu));
  } catch {
    /* Private browsing can deny storage; the freshly read menu still works. */
  }
  return menu;
}
