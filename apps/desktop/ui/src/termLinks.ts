/**
 * Terminal link detection: ONE logical line of text in, link spans out.
 *
 * This is deliberately a pure function with no xterm/DOM/RPC dependency. The
 * rules used to live inline in Term.tsx's link provider, where every new case
 * (CJK names, bare filenames, wrapped lines) was another patch on a regex that
 * nothing could test. Terminal geometry — mapping code units to columns,
 * rejoining soft-wrapped rows, extending an underline across the TUI's own
 * hard wraps — stays in Term.tsx; everything about *what counts as a link*
 * lives here, with a table-driven spec next to it.
 *
 * Neither agent marks its output up for us: claude only emits OSC 8 hyperlinks
 * when the terminal advertises support (ours doesn't, and even forced on it
 * links docs URLs, never file paths), and codex — which is explicitly told to
 * write file references as inline code with `:line[:column]` / `#Lline[Ccolumn]`
 * suffixes — hands them over as plain text too. So detection is on us, and the
 * shapes codex is instructed to produce are exactly the shapes we parse.
 */

/** Path segment characters — ASCII path chars + CJK (agents very often name
 *  files/reports in the user's language, e.g. `早停101~300不合规名单.md`). */
export const SEG = "A-Za-z0-9_.+@\\-~\\u4e00-\\u9fff\\u3400-\\u4dbf";
/** SEG without the dot — used to tell "the name continues" from "a sentence
 *  ends here", which a plain [SEG] lookahead cannot do. */
const SEG_NODOT = 'A-Za-z0-9_+@\\-~\\u4e00-\\u9fff\\u3400-\\u4dbf';

/** The known extension must END the filename. Without this guard the
 *  alternation happily matched a PREFIX of a longer extension — `run.jsonl`
 *  linked as `run.json` (a file that doesn't exist), which in this repo full
 *  of .jsonl transcripts is a click that always fails. Two lookaheads: not
 *  followed by a name character, and not followed by dot+name character
 *  (so `report.md.bak` is refused while `report.md.` at the end of a
 *  sentence still links, its period trimmed as punctuation). */
const EXT_END = `(?![${SEG_NODOT}])(?!\\.[${SEG_NODOT}])`;

/** Known extensions for the BARE-filename case (no '/' at all) — required
 *  there (unlike the slash-anchored cases) because without a slash to anchor
 *  it, "any 1-8 alnum chars after a dot" also matches ordinary prose like
 *  decimal numbers ("7.5") or abbreviations ("e.g."). A slash is proof-enough
 *  of pathiness on its own; a bare word is not. */
const KNOWN_EXT =
  '(?:md|txt|json|ya?ml|csv|log|sql|py|ipynb|ts|tsx|js|jsx|mjs|cjs|sh|bash|zsh|rs|go|java|kt|swift|cs|cc?|cpp|hpp?|rb|php|html?|css|scss|less|xml|toml|cfg|conf|env|png|jpe?g|gif|svg|webp|bmp|ico|heic|pdf|docx?|xlsx?|pptx?|zip|tar|gz|rar|7z|mp4|mov|avi|mp3|wav|m4a)';

/** http(s) URLs — agents print them constantly (PR links, docs, releases). */
const URL_RE = /https?:\/\/[^\s'"`<>()[\]{}]+/g;

/** Path shapes:
 *   • absolute        /usr/local/bin/foo
 *   • home-relative   ~/Downloads/x.png
 *   • relative with at least one '/' AND a file extension
 *   • bare filename with a KNOWN extension and no slash at all
 *
 *  Anchored on "start of line, or any character that cannot be part of a
 *  path" so we never snip mid-word. Stating it as a blacklist matters: the
 *  old whitelist (whitespace, quotes, brackets) silently refused every path
 *  introduced by a delimiter — `--out=/tmp/x.png`, `cwd:/Users/…`, `→ a/b.ts`
 *  — which agents print constantly. Mid-word is still blocked, because the
 *  character before a real path is never a path character. */
const PATH_RE = new RegExp(
  `(?:^|[^${SEG}])(\\/[${SEG}/]+|~\\/[${SEG}/]+|[${SEG}]+\\/[${SEG}/]+\\.[A-Za-z0-9]{1,8}|[${SEG}]+\\.${KNOWN_EXT}${EXT_END})`,
  'gi',
);

/** Backticked inline code. codex's system prompt orders the model to wrap
 *  every file reference in it, which makes the backticks themselves strong
 *  evidence — so inside them we accept shapes the bare-prose rules refuse
 *  (a directory, or a file whose extension isn't on the known list). Tokens
 *  with whitespace are commands, not paths, and never match. */
const CODE_RE = /`([^`\s]+)`/g;

/** Sentence punctuation the matchers may glue onto the end of a link. */
export const TRAIL_RE = /[.,;:!?)\]>'"`]+$/;

/** `:42`, `:42:8`, `#L42`, `#L42C8` — both forms codex is told to emit, and
 *  what compilers/stack traces print anyway. Anchored at the end of the
 *  reference so a colon inside a path can't be mistaken for a location. */
const LOC_RE = /^(.+?)(?::(\d{1,7})(?::(\d{1,7}))?|#L(\d{1,7})(?:C(\d{1,7}))?)$/;

/** Location suffix immediately FOLLOWING a matched path (the path matchers
 *  stop at ':' / '#', which are not path-segment characters). */
const LOC_AHEAD_RE = /^(?::\d{1,7}(?::\d{1,7})?|#L\d{1,7}(?:C\d{1,7})?)/;

/** shortest thing we are willing to call a link ("a.md" is exactly 4) */
const MIN_LEN = 4;

export interface LinkSpan {
  /** [start, end) into the logical line — what gets underlined */
  readonly start: number;
  readonly end: number;
  readonly kind: 'url' | 'path';
  /** the URL, or the path with any location suffix removed */
  readonly target: string;
  /** 1-based, when the reference carried a location */
  readonly line?: number;
  readonly column?: number;
}

/** Split `foo.ts:42:8` / `foo.ts#L42C8` into path + location. */
function splitLoc(ref: string): { path: string; line?: number; column?: number } {
  const m = LOC_RE.exec(ref);
  const path = m?.[1];
  if (!m || !path) return { path: ref };
  const line = Number(m[2] ?? m[4]);
  const col = m[3] ?? m[5];
  return { path, line, ...(col ? { column: Number(col) } : {}) };
}

/** Does this backticked token look like a path rather than a command/identifier? */
function codeTokenIsPathy(token: string): boolean {
  if (token.includes('/')) return true; // a/b, src/app.ts, apps/desktop/ui
  return /\.[A-Za-z0-9]{1,8}$/.test(splitLoc(token).path); // Cargo.toml, foo.mdx
}

/**
 * Every link in one logical line, ordered by position and never overlapping.
 * URLs win over paths (a URL's own path part must not become a file link),
 * and the first match of a span wins over any later one.
 */
export function findLinks(text: string): LinkSpan[] {
  const spans: LinkSpan[] = [];
  const overlaps = (start: number, end: number): boolean =>
    spans.some((s) => start < s.end && end > s.start);

  const push = (start: number, raw: string, kind: 'url' | 'path'): void => {
    const trimmed = raw.replace(TRAIL_RE, '');
    if (trimmed.length < MIN_LEN) return;
    let end = start + trimmed.length;
    if (kind === 'url') {
      if (overlaps(start, end)) return;
      spans.push({ start, end, kind, target: trimmed });
      return;
    }
    // a location suffix sits just past the match — underline it as part of
    // the link, but keep it out of the path we try to open
    const ahead = LOC_AHEAD_RE.exec(text.slice(end));
    const ref = ahead ? trimmed + ahead[0] : trimmed;
    if (ahead) end += ahead[0].length;
    if (overlaps(start, end)) return;
    const { path, line, column } = splitLoc(ref);
    if (path.length < MIN_LEN) return;
    spans.push({
      start,
      end,
      kind,
      target: path,
      ...(line !== undefined ? { line } : {}),
      ...(column !== undefined ? { column } : {}),
    });
  };

  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex.exec idiom
  while ((m = URL_RE.exec(text)) !== null) push(m.index, m[0], 'url');

  PATH_RE.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex.exec idiom
  while ((m = PATH_RE.exec(text)) !== null) {
    const t = m[1];
    if (t) push(m.index + (m[0].length - t.length), t, 'path');
  }

  CODE_RE.lastIndex = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex.exec idiom
  while ((m = CODE_RE.exec(text)) !== null) {
    const t = m[1];
    if (t && codeTokenIsPathy(t)) push(m.index + 1, t, 'path');
  }

  return spans.sort((a, b) => a.start - b.start);
}
