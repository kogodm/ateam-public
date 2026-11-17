export interface PickerOption {
  /** the option number (model menus require arrows, since digits also confirm) */
  n: number;
  label: string;
  description?: string;
  selected?: boolean;
  /** multi-select question: whether this option's box is ticked */
  checked?: boolean;
}

export interface TuiPicker {
  title?: string;
  options: PickerOption[];
  /** the footer line, e.g. "Enter to set as default · s to … · Esc to cancel" */
  hint: string;
  /** false: the menu draws no numbers (Claude 2.1.303's confirm boxes), so a
   *  digit does nothing — reach the option with the arrows, then Enter.
   *  `n` is then only the option's position. Absent = numbered. */
  numbered?: false;
  /** a multi-select question (AskUserQuestion with multiSelect): a digit
   *  toggles that option's box, and the "Next" row — which sits between the
   *  options and "Chat about this", and is not numbered — moves on. */
  multi?: { nextSelected: boolean };
}

/** Both runtimes lay a picker out the same way — "  N. Label   description",
 *  one row marked as current, a footer naming the keys — and differ only in
 *  the two details this file keys on. Captured from a live codex 0.147:
 *
 *      Select Model and Effort
 *    › 1. gpt-5.6-sol (current)  Latest frontier agentic coding model.
 *      2. gpt-5.6-terra          Balanced agentic coding model for everyday work.
 *      Press enter to confirm or esc to go back
 *
 *  so the marker is '›' rather than claude's '❯', and the footer says "Press
 *  enter to …" rather than "Enter to …". Neither matched, and codex menus
 *  therefore reached the phone as unreadable text instead of buttons.
 *
 *  Widening these is safe because the real guard is downstream: at least two
 *  options, numbered in an unbroken 1..N run, directly above the footer. */
const FOOTER_RE =
  /(Enter to (?:select|set|confirm)|Press enter to (?:confirm|continue|select)|↑\/↓ to navigate|[Ee]sc to (?:cancel|go back)|^\s*enter (?:select|default|confirm|continue)\s*·.*\besc (?:back|skip)\s*$)/;
const OPTION_RE = /^(\s*)([❯›]\s*)?(?:[↑↓]\s*)?(\d{1,2})\.\s+(\S.*)$/;
const MODEL_TRUNCATION_RE = /^\s*(?:…|\.\.\.)\s*\+\d+\s+models?\s*$/i;
/** a row carrying the TUI's selection marker, numbered or not */
const MARKER_ROW_RE = /^(\s*)[❯›]\s+\S/;

/**
 * Recognise a picker on the terminal's CURRENT SCREEN.
 *
 * Deliberately strict — a false positive would put fake buttons under a
 * normal conversation: at least two numbered options must sit contiguously,
 * and either a footer names the keys below them or one of them carries the
 * TUI's own selection marker.
 *
 * The second case is not hypothetical. Claude 2.1.268 asks a conversation
 * that already has a cache to confirm a model switch:
 *
 *     Switch model?
 *     This conversation is cached for the current model. Switching to
 *     Fable 5.1 means the full history gets re-read on your next message.
 *
 *     ❯ 1. Yes, switch to Fable 5.1
 *       2. No, go back
 *
 * and that box draws NO footer (captured from a live 2.1.268 — the row under
 * the options is blank). A footer-only rule made it invisible in stream mode,
 * which is worse than it sounds: the phone showed the model list, took the
 * tap, and then sat on a modal the user could neither see nor answer.
 */
export function parsePicker(rows: readonly string[]): TuiPicker | null {
  return parseRows(rows) ?? parseOverlay(rows);
}

/**
 * A dialog codex draws over the middle of a busy screen (captured live from
 * 0.162.0 after a long reply; the box starts at column 18):
 *
 *       16. Handle error› 1. Yes, continue anyway  Apply full access …
 *       17. Validate inp  2. Cancel                Go back without …
 *       19. Minimize sha  enter select · esc back
 *
 * The reply's text stays on the left of every row, so no row starts with the
 * option or the footer and the whole dialog read as nothing — the stream view
 * never showed it and the person had to answer it in the terminal. Find a
 * footer that starts mid-row after a gap, cut every row at the box's left edge
 * (the footer's column less the marker's two), and read what is left.
 */
function parseOverlay(rows: readonly string[]): TuiPicker | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] ?? '';
    for (const gap of row.matchAll(/\S\s{2,}(?=\S)/g)) {
      const start = (gap.index ?? 0) + gap[0].length;
      if (start < 8 || !FOOTER_RE.test(row.slice(start))) continue;
      const left = start - 2;
      return parseRows(rows.map((r) => r.slice(left)));
    }
  }
  return null;
}

function parseRows(rows: readonly string[]): TuiPicker | null {
  let footerIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row && FOOTER_RE.test(row)) {
      footerIdx = i;
      break;
    }
  }
  // No footer: fall back to the bottom-most numbered row. Two guards replace
  // the footer — the run must carry the TUI's own selection marker (prose that
  // happens to number its lines never does), and it must be the LAST thing
  // drawn. A modal confirm ends there; a picker whose footer went missing
  // because the frame was drawn for a taller screen has its wreckage below
  // the options, and stays unreadable on purpose.
  const lastOpt = footerIdx >= 0 ? -1 : lastOptionIdx(rows);
  const trailing = rows.slice(lastOpt + 1).filter((r) => r.trim());
  if (
    footerIdx < 0 &&
    (lastOpt < 0 ||
      trailing.length > 1 ||
      (trailing.length === 1 && !MODEL_TRUNCATION_RE.test(trailing[0] ?? '')))
  )
    return null;
  const fromIdx = footerIdx >= 0 ? footerIdx : lastOpt + 1;
  if (fromIdx <= 0) return null;

  const options: PickerOption[] = [];
  let title: string | undefined;
  // AskUserQuestion draws each option's description on its OWN deeply
  // indented line UNDER the option. Walking up, that line is met before its
  // option — hold it until the option arrives, or it lands on the one below.
  let pendingDesc: string | undefined;
  let highlighted: number | undefined;
  let firstOptionIdx = -1;
  // Rows met before the first option. A model menu puts "… +3 models" and an
  // effort note there; nothing else does. Without this bound the walk ran on
  // up the screen past a menu it could not read (2.1.303 draws some with no
  // numbers) and took the numbered list of the reply above it for the options.
  let notes = 0;
  // multi-select questions draw an unnumbered "Next" row under the options
  let nextRow = false;
  let nextSelected = false;
  // leftmost column the options start at (marker or number)
  let left = Number.POSITIVE_INFINITY;
  // walk up from the footer; options are a contiguous run (blank lines and
  // one-off notes like "● High effort" may sit between them and the footer)
  for (let i = fromIdx - 1; i >= 0 && fromIdx - i < 30; i--) {
    const row = rows[i] ?? '';
    const m = OPTION_RE.exec(row);
    if (!m && options.length === 0 && row.trim() && !/^\s{4,}\S/.test(row)) {
      if (MARKER_ROW_RE.test(row) || ++notes > 2) break;
    }
    if (m) {
      firstOptionIdx = i;
      left = Math.min(left, (m[1] ?? '').length);
      const rest = m[4] ?? '';
      if (m[2]) highlighted = Number(m[3]);
      // two-column layout: label, 2+ spaces, description
      const split = /^(.*?)\s{2,}(\S.*)$/.exec(rest);
      options.unshift({
        n: Number(m[3]),
        label: (split ? (split[1] ?? '') : rest).replace(/\s+✔$/, '').trim(),
        description: split
          ? [(split[2] ?? '').trim(), pendingDesc].filter(Boolean).join(' ')
          : pendingDesc,
        selected: Boolean(m[2]) || /✔/.test(rest),
      });
      pendingDesc = undefined;
      continue;
    }
    if (/^\s*[↑↓].*models?\s*$/i.test(row)) continue;
    if (options.length > 0 && !nextRow && /^\s*(?:[❯›]\s*)?Next\s*$/.test(row)) {
      nextRow = true;
      nextSelected = /[❯›]/.test(row);
      continue;
    }
    if (/^\s{4,}\S/.test(row)) {
      pendingDesc = [row.trim(), pendingDesc].filter(Boolean).join(' ');
      continue;
    }
    pendingDesc = undefined;
    if (options.length > 0 && row.trim()) {
      if (/^[\s│╭╰─═┌└]*$/.test(row)) continue;
      // first shallow prose line above the run is the picker's title
      title = row.trim();
      break;
    }
  }
  if (options.length < 2) return footerIdx >= 0 ? parseUnnumbered(rows, footerIdx) : null;
  // A dialog codex draws over the middle of the screen leaves the old text
  // to its left on the same rows ("  /status - show c  Enable full access?").
  // Read the heading from the dialog's own columns, or it never equals the
  // title other code keys on.
  const overlay = rows
    .slice(Math.max(0, firstOptionIdx - 12), firstOptionIdx)
    .some((r) => /\S/.test(r.slice(0, left)) && /\S/.test(r.slice(left)) && left >= 8);
  const view = overlay ? rows.map((r) => r.slice(left)) : rows;
  if (overlay) {
    title = view
      .slice(Math.max(0, firstOptionIdx - 12), firstOptionIdx)
      .reverse()
      .find((r) => r.trim() && !/^\s{4,}\S/.test(r))
      ?.trim();
  }
  // Model menus can put their identifying title several explanation rows
  // above the options. Restrict this override to the two known model titles.
  const modelTitle =
    firstOptionIdx < 0
      ? undefined
      : rows
          .slice(Math.max(0, firstOptionIdx - 8), firstOptionIdx)
          .reverse()
          .find((row) => /^\s*(?:Select model|Select Model and Effort)\s*$/i.test(row))
          ?.trim();
  if (modelTitle) title = modelTitle;
  // A confirmation box heads its wrapped explanation with a question, and the
  // explanation is what "the first prose line above the options" lands on —
  // "re-read on your next message." instead of "Switch model?". Prefer a
  // heading that asks, when one is within reach; every other picker has none
  // and keeps the line above.
  const asked = questionAbove(view, fromIdx);
  if (asked) title = asked;
  if (!asked && title?.startsWith('⚠')) {
    const heading = rows
      .slice(Math.max(0, fromIdx - 12), fromIdx)
      .find((row) => /^\s*Advanced Reasoning\s*$/.test(row));
    if (heading) title = `${heading.trim()} — ${title}`;
  }
  // A checkmark can denote the applied model while the cursor is elsewhere.
  if (highlighted !== undefined) {
    for (const option of options) option.selected = option.n === highlighted;
  }
  // Scrolled model lists retain absolute numbers; other dialogs keep the
  // stricter 1..N rule so numbered prose cannot become a picker.
  const first = /select model|model and effort/i.test(title ?? '') ? (options[0]?.n ?? 1) : 1;
  if (options.some((o, i) => o.n !== i + first)) return null;
  // footerless only counts with the marker — that is the whole guard there
  if (footerIdx < 0 && !options.some((o) => o.selected)) return null;
  const hint = footerIdx >= 0 ? (rows[footerIdx] ?? '').trim() : '';
  const boxes = nextRow ? withCheckboxes(options) : undefined;
  return boxes
    ? { title, options: boxes, hint, multi: { nextSelected } }
    : { title, options, hint };
}

const CHECKBOX_RE = /^\[([ ✔✓xX])\]\s*/;

/** The options of a multi-select question with their boxes read into
 *  `checked` and taken off the label; undefined when they are not boxes. */
function withCheckboxes(options: PickerOption[]): PickerOption[] | undefined {
  const boxed = options.filter((o) => !/^chat about this$/i.test(o.label));
  if (boxed.length === 0 || !boxed.every((o) => CHECKBOX_RE.test(o.label))) return undefined;
  return options.map((o) => {
    const m = CHECKBOX_RE.exec(o.label);
    return m ? { ...o, label: o.label.replace(CHECKBOX_RE, ''), checked: m[1] !== ' ' } : o;
  });
}

/**
 * A menu drawn WITHOUT numbers, directly above its footer. Claude 2.1.303
 * draws its confirm boxes this way (captured live, 108 columns):
 *
 *      Security guide
 *
 *     ❯ No, exit
 *       Yes, I trust this folder
 *
 *     Enter to confirm · Esc to cancel
 *
 * The options are the block of rows ending just above the footer, every one
 * starting where the marked row's label starts, with exactly one marked.
 * Any other row ends the block, so prose above never joins it.
 */
function parseUnnumbered(rows: readonly string[], footerIdx: number): TuiPicker | null {
  let i = footerIdx - 1;
  for (let blanks = 0; i >= 0 && !(rows[i] ?? '').trim(); i--) if (++blanks > 2) return null;
  const block: string[] = [];
  for (; i >= 0 && (rows[i] ?? '').trim() && block.length < 10; i--) block.unshift(rows[i] ?? '');
  const marked = block.findIndex((r) => MARKER_ROW_RE.test(r));
  if (marked < 0 || block.some((r, k) => k !== marked && MARKER_ROW_RE.test(r))) return null;
  // the column the marked row's label starts at; the others align with it
  const col = /^\s*[❯›]\s+/.exec(block[marked] ?? '')?.[0].length ?? -1;
  const isOption = (r: string, k: number): boolean =>
    k === marked || (r.search(/\S/) === col && !OPTION_RE.test(r));
  // the run of option rows that reaches the footer and contains the mark
  let start = block.length;
  while (start > 0 && isOption(block[start - 1] ?? '', start - 1)) start--;
  if (start > marked) return null;
  const run = block.slice(start);
  if (run.length < 2) return null;
  const options = run.map((r, k) => ({
    n: k + 1,
    label: r.replace(/^\s*[❯›]?\s*/, '').trim(),
    selected: start + k === marked,
  }));
  // block[0] sits at rows[i + 1]; the title is the nearest prose above the run
  const title =
    questionAbove(rows, footerIdx) ||
    rows
      .slice(0, i + 1 + start)
      .reverse()
      .find((r) => r.trim())
      ?.trim();
  return { title, options, hint: (rows[footerIdx] ?? '').trim(), numbered: false };
}

/** The nearest heading ending in '?' just above a picker's options — the
 *  title of a confirmation box. '' when there is none within reach. */
function questionAbove(rows: readonly string[], fromIdx: number): string {
  for (let i = fromIdx - 1; i >= 0 && fromIdx - i <= 12; i--) {
    const row = (rows[i] ?? '').trim();
    if (/[?？]$/.test(row) && row.length <= 60) return withWrappedHead(rows, i, row);
  }
  return '';
}

/** A long question wraps over several rows and the one ending in '?' is only
 *  its tail — pull the rows above it back in, up to a blank row, the header
 *  chip, or anything that is not plain prose. */
function withWrappedHead(rows: readonly string[], at: number, tail: string): string {
  let text = tail;
  for (let i = at - 1; i >= 0 && at - i <= 6; i--) {
    const row = (rows[i] ?? '').trim();
    if (!row || OPTION_RE.test(row) || /^[☐☒✔✓←\u2500-\u259f]/.test(row)) break;
    // CJK wraps mid-word without a space; Latin text needs one
    const glue = /[\u3000-\u9fff\uff00-\uffef]/.test(row.slice(-1)) ? '' : ' ';
    text = `${row}${glue}${text}`;
  }
  return text;
}

/** Index of the bottom-most row that reads as a numbered option, or -1. */
function lastOptionIdx(rows: readonly string[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (OPTION_RE.test(rows[i] ?? '')) return i;
  }
  return -1;
}

const PLACEHOLDER_RE = /^type something\.?$/i;

/**
 * The row of a claude AskUserQuestion picker that is a TEXT FIELD ("Type
 * something."). Its digit does not choose it: the digit is typed into the
 * field — tapping it twice on a phone left "33" there and nothing submitted
 * (09-18). Once typed into, the row shows the typed text instead of the
 * placeholder, so it is also known as the row right above "Chat about this".
 */
export function freeTextOption(p: TuiPicker): PickerOption | undefined {
  const byName = p.options.find((o) => PLACEHOLDER_RE.test(o.label.trim()));
  if (byName) return byName;
  const chat = p.options.findIndex((o) => /^chat about this$/i.test(o.label.trim()));
  return chat > 0 ? p.options[chat - 1] : undefined;
}

/** what is already typed into the field ('' while it shows the placeholder) */
export function typedIn(o: PickerOption): string {
  return PLACEHOLDER_RE.test(o.label.trim()) ? '' : o.label.trim();
}

/** arrow keys that move the picker's cursor onto `target` without typing */
export function keysToReach(p: TuiPicker, target: PickerOption): string {
  const at = p.options.findIndex((o) => o.selected);
  const to = p.options.indexOf(target);
  if (to < 0) return '';
  const from = at < 0 ? 0 : at;
  const d = to - from;
  return (d > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(d));
}

/** arrow keys from the cursor to a multi-select question's "Next" row, which
 *  sits right after the last option that has a box (before "Chat about this") */
export function keysToNext(p: TuiPicker): string {
  if (!p.multi) return '';
  const boxed = p.options.filter((o) => o.checked !== undefined);
  const nextAt = boxed.length; // position of Next in the cursor's order
  const cursor = p.multi.nextSelected
    ? nextAt
    : (() => {
        const i = p.options.findIndex((o) => o.selected);
        // options after the boxed ones ("Chat about this") sit past Next
        return i < 0 ? 0 : i < boxed.length ? i : i + 1;
      })();
  const d = nextAt - cursor;
  if (d === 0) return '';
  return (d > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(d));
}
