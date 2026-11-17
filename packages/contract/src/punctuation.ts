/**
 * Chinese and fullwidth punctuation, rewritten to ASCII before text is typed
 * into a CLI. Every mark is replaced; letters and digits are left as they are.
 * A second pass is a no-op, so the composer and the session input can both
 * apply it.
 */
const MARK: Record<string, string> = {
  '\u3001': ',', // 、
  '\u3002': '.', // 。
  '\u00b7': '.', // ·
  '\u30fb': '.', // ・
  '\u2027': '.', // ‧
  '\uff65': '.', // ･
  '\u3003': '"', // 〃
  '\u3008': '<', // 〈
  '\u3009': '>', // 〉
  '\u300a': '<', // 《
  '\u300b': '>', // 》
  '\u300c': '"', // 「
  '\u300d': '"', // 」
  '\u300e': '"', // 『
  '\u300f': '"', // 』
  '\u3010': '[', // 【
  '\u3011': ']', // 】
  '\u3014': '[', // 〔
  '\u3015': ']', // 〕
  '\u3016': '[', // 〖
  '\u3017': ']', // 〗
  '\u3018': '[', // 〘
  '\u3019': ']', // 〙
  '\u301a': '[', // 〚
  '\u301b': ']', // 〛
  '\u301c': '~', // 〜
  '\u301d': '"', // 〝
  '\u301e': '"', // 〞
  '\u301f': '"', // 〟
  '\u3030': '~', // 〰
  '\u201c': '"', // “
  '\u201d': '"', // ”
  '\u201e': '"', // „
  '\u201f': '"', // ‟
  '\u2018': "'", // ‘
  '\u2019': "'", // ’
  '\u201a': "'", // ‚
  '\u201b': "'", // ‛
  '\u2010': '-', // ‐
  '\u2011': '-', // ‑
  '\u2012': '-', // ‒
  '\u2013': '-', // –
  '\u2212': '-', // −
  '\ufe63': '-', // ﹣
  '\ufe59': '(', // ﹙
  '\ufe5a': ')', // ﹚
  '\ufe5b': '{', // ﹛
  '\ufe5c': '}', // ﹜
  '\ufe5d': '[', // ﹝
  '\ufe5e': ']', // ﹞
  // Fullwidth parens also sit in FF01–FF5E (converted below); listed here so a
  // glance at the table shows brackets are covered. White parens are outside
  // that range and need an explicit entry.
  '\uff08': '(', // （
  '\uff09': ')', // ）
  '\uff5f': '(', // ｟
  '\uff60': ')', // ｠
  '\u3000': ' ', // fullwidth space
};

export function asciiPunctuation(text: string): string {
  if (!text) return text;
  const normalized = text
    .replace(/\u2026+/g, '...')
    .replace(/\u22ef+/g, '...')
    .replace(/\u2014+/g, '--')
    .replace(/\u2015+/g, '--');
  let out = '';
  for (const ch of normalized) {
    const mapped = MARK[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.charCodeAt(0);
    // Fullwidth ASCII forms (！＂＃ … ～) sit 0xFEE0 above the ASCII character.
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0);
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Rewrite punctuation and keep the caret on the same logical spot when a
 * mark expands (… → ...) or shrinks. Used by the live composer rewrite.
 */
export function asciiPunctuationAt(
  text: string,
  caret: number,
): { text: string; caret: number } {
  const safe = Math.max(0, Math.min(caret, text.length));
  const next = asciiPunctuation(text);
  if (next === text) return { text, caret: safe };
  return { text: next, caret: asciiPunctuation(text.slice(0, safe)).length };
}
