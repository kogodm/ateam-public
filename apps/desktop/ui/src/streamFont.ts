/**
 * Stream view reading font and size (Settings → Appearance). Kept per device
 * in localStorage, the same as the theme: a phone and a desktop want
 * different sizes. Applied as two CSS variables on the root element —
 * `--sv-font` (family, '' = the app's own) and `--sv-scale` (every size in
 * the stream view is multiplied by it, so tool cards and thinking lines keep
 * their proportions to the message text).
 */
export interface StreamFont {
  font: string;
  /** message text size in px */
  size: number;
}

/** `probe` = the named families that make the option what it says. The
 *  option is offered only when one of them is installed on THIS device —
 *  nothing is bundled, and a stack whose fonts are all missing silently falls
 *  back to a generic face (on a stock Mac, Kai looked exactly like Serif). */
export const STREAM_FONTS: readonly { id: string; label: string; css: string; probe: string[] }[] =
  [
    { id: 'system', label: 'Default', css: '', probe: [] },
    {
      id: 'sans',
      label: 'Sans',
      css: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif',
      probe: ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC'],
    },
    {
      id: 'serif',
      label: 'Serif',
      css: '"Songti SC", "SimSun", "Noto Serif CJK SC", "Noto Serif SC", serif',
      probe: ['Songti SC', 'SimSun', 'Noto Serif CJK SC', 'Noto Serif SC'],
    },
    {
      id: 'kai',
      label: 'Kai',
      css: '"Kaiti SC", "STKaiti", "KaiTi", "LXGW WenKai", serif',
      probe: ['Kaiti SC', 'STKaiti', 'KaiTi', 'LXGW WenKai'],
    },
    {
      id: 'mono',
      label: 'Mono',
      css: 'ui-monospace, "SF Mono", Menlo, Consolas, "PingFang SC", monospace',
      probe: [],
    },
  ];

/** Options this device can actually show. Default and Mono always can (a
 *  monospace face always exists); the rest need one probed family. */
export function availableStreamFonts(
  installed: (family: string) => boolean = fontInstalled,
): typeof STREAM_FONTS {
  return STREAM_FONTS.filter((f) => f.probe.length === 0 || f.probe.some((p) => installed(p)));
}

/**
 * Is `family` installed? Text drawn in it measures differently from the
 * generic fallbacks. Latin glyphs carry the signal (CJK glyphs are one em
 * wide in nearly every font), and two fallbacks guard against a family that
 * happens to match one of them.
 */
let measureCtx: CanvasRenderingContext2D | null | undefined;
const installedCache = new Map<string, boolean>();
export function fontInstalled(family: string): boolean {
  const hit = installedCache.get(family);
  if (hit !== undefined) return hit;
  if (measureCtx === undefined) {
    measureCtx =
      typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  const ctx = measureCtx;
  if (!ctx) return false;
  const sample = 'mmmmmmmmmmlliWWW0123 永和';
  const width = (font: string): number => {
    ctx.font = font;
    return ctx.measureText(sample).width;
  };
  const yes = ['monospace', 'serif'].some(
    (fallback) => width(`72px "${family}", ${fallback}`) !== width(`72px ${fallback}`),
  );
  installedCache.set(family, yes);
  return yes;
}

export const STREAM_SIZE = { min: 11, max: 22, step: 0.5, base: 13.5 } as const;
export const DEFAULT_STREAM_FONT: StreamFont = { font: 'system', size: STREAM_SIZE.base };

const KEY = 'ateam.streamFont';

export function clampSize(n: number): number {
  if (!Number.isFinite(n)) return STREAM_SIZE.base;
  const stepped = Math.round(n / STREAM_SIZE.step) * STREAM_SIZE.step;
  return Math.min(STREAM_SIZE.max, Math.max(STREAM_SIZE.min, stepped));
}

export function readStreamFont(): StreamFont {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<StreamFont> | null;
    if (!o) return DEFAULT_STREAM_FONT;
    const font = STREAM_FONTS.some((f) => f.id === o.font) ? (o.font as string) : 'system';
    return { font, size: clampSize(Number(o.size)) };
  } catch {
    return DEFAULT_STREAM_FONT;
  }
}

export function applyStreamFont(v: StreamFont): void {
  const root = document.documentElement.style;
  const css = STREAM_FONTS.find((f) => f.id === v.font)?.css ?? '';
  if (css) root.setProperty('--sv-font', css);
  else root.removeProperty('--sv-font');
  root.setProperty('--sv-scale', String(clampSize(v.size) / STREAM_SIZE.base));
}

export function saveStreamFont(v: StreamFont): void {
  applyStreamFont(v);
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable — applies for this run only */
  }
}
