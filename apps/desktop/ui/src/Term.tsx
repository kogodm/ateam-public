import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { type ILink, Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { keyboardTapIntent } from './keyboardZone';
import { PASTE_MAX_BYTES, fileBase64, imageFilesFrom, pastedName } from './pasteImages';
import { PATH_DRAG_MIME, formatPathForInput } from './pathInsert';
import { blurRelayInput, focusRelayInput } from './relayInput';
import { afterDrag } from './resizeGate';
import type { Rpc } from './rpc';
import { TRAIL_RE, findLinks } from './termLinks';
import { registerTerm, unregisterTerm } from './termRegistry';
import { type RowText, type WrappedToken, wrappedTokenAt } from './termWrap';
import { takeWheelSteps } from './touchScroll';

/**
 * One xterm.js bound to one claude PTY session. Mounted for the lifetime of
 * the session (hidden when not focused) so no live output is ever missed —
 * the same model the TUI uses.
 */

const TERM_FONT_FAMILY = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const TERM_FONT_SIZE = 14;
const TERM_LINE_HEIGHT = 1.2;
/** inner padding of .term-host (styles.css) — fit() excludes it */
const TERM_HOST_PADDING = 4;

/** How long the host size must hold still before the PTY is told about it. */
const RESIZE_SETTLE_MS = 120;

/** Rows a single touch batch may scroll. A flick past this is already beyond
 *  any useful speed, and the excess would keep firing after the finger stops. */
const MAX_WHEEL_STEPS = 12;

/**
 * Re-measure the scrollbar after this terminal comes back into view.
 *
 * xterm sizes its scroll area from `viewportElement.offsetHeight`, which is 0
 * for as long as the Term is hidden (`display:none` — every session that is
 * not the focused one). Output still arrives while hidden, and each refresh
 * bakes that 0 into the cached height, leaving a scroll area a full viewport
 * SHORT. Nothing re-measures on the way back: none of xterm's own triggers
 * (onScroll, onDimensionsChange, _afterResize, the scrollback option) fire on
 * a display change, and fit() is a no-op when the pane is the size it already
 * was, so `term.resize()` returns early without an _afterResize.
 *
 * What the user sees: switch to a session, scroll up, and you cannot get back
 * to the bottom — the last screen is unreachable until new output changes the
 * line count (which does trigger a sync) or you press Enter.
 *
 * `syncScrollArea` is internal (verified against @xterm/xterm 5.x); optional
 * chaining keeps a rename harmless — the scrollbar would go back to being
 * stale, nothing throws.
 */
function remeasureViewport(term: Terminal): void {
  (
    term as unknown as {
      _core?: { viewport?: { syncScrollArea?: (immediate?: boolean) => void } };
    }
  )._core?.viewport?.syncScrollArea?.(true);
}

/** Estimate the cols×rows a terminal mounted in `stage` would get, using the
 *  same font metrics xterm's fit addon measures (a span of the cell font).
 *  Lets App tell the core the pane size BEFORE the first session exists, so
 *  the very first claude boots at the real width instead of 120×32. */
export function estimateTermDims(stage: HTMLElement): { cols: number; rows: number } | null {
  const r = stage.getBoundingClientRect();
  if (r.width < 40 || r.height < 40) return null;
  const probe = document.createElement('span');
  probe.textContent = 'W'.repeat(20);
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${TERM_FONT_FAMILY};font-size:${TERM_FONT_SIZE}px;line-height:normal`;
  stage.appendChild(probe);
  const cellW = probe.getBoundingClientRect().width / 20;
  const cellH = Math.ceil(probe.getBoundingClientRect().height * TERM_LINE_HEIGHT);
  probe.remove();
  if (!cellW || !cellH) return null;
  const availW = r.width - TERM_HOST_PADDING * 2;
  const availH = r.height - TERM_HOST_PADDING * 2;
  const cols = Math.max(2, Math.floor(availW / cellW));
  const rows = Math.max(2, Math.floor(availH / cellH));
  return { cols, rows };
}

export function Term({
  sessionId,
  rpc,
  active,
  cwd,
  onOpenPath,
  readOnly,
  pendingHandoff,
  humanName,
  onUserInput,
  style,
}: {
  sessionId: string;
  rpc: Rpc;
  active: boolean;
  /** session cwd — used to resolve relative path links in terminal output */
  cwd?: string;
  onOpenPath?: (path: string, cwd?: string, line?: number, column?: number) => void;
  /** the teammate this session is — shown in the handoff overlay */
  humanName?: string;
  /** Don't forward keyboard input to the PTY. Used for the "frozen" old
   *  session in the auto-handoff dual stack (history scrollable, no typing). */
  readOnly?: boolean;
  /** Handoff in flight — render a small processing overlay that blocks
   *  clicks and disables input until the successor session takes over. */
  pendingHandoff?: boolean;
  /** Fired the first time (and every time) the user actually types a
   *  keystroke into THIS session's terminal. App uses it to mark the
   *  session "engaged" so replayed/restored output can't flag it unread. */
  onUserInput?: (sessionId: string) => void;
  /** Extra inline style merged into the host div — used for the dual-stack
   *  flex sizing/ordering when a successor session is in play. */
  style?: React.CSSProperties;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // in-terminal find (Cmd+F): searches the xterm buffer via the search addon
  const searchRef = useRef<SearchAddon | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findRes, setFindRes] = useState<{ index: number; count: number }>({ index: -1, count: 0 });
  const [dragActive, setDragActive] = useState(false);
  // captured in refs so changing the handler / cwd doesn't tear down the term
  const onOpenPathRef = useRef(onOpenPath);
  useEffect(() => {
    onOpenPathRef.current = onOpenPath;
  }, [onOpenPath]);
  const cwdRef = useRef(cwd);
  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);
  // active also captured: the session.output listener uses it to decide
  // whether to auto-tail without re-creating the terminal on focus changes.
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const readOnlyRef = useRef(readOnly ?? false);
  useEffect(() => {
    readOnlyRef.current = readOnly ?? false;
  }, [readOnly]);
  const pendingHandoffRef = useRef(pendingHandoff ?? false);
  useEffect(() => {
    pendingHandoffRef.current = pendingHandoff ?? false;
  }, [pendingHandoff]);
  const onUserInputRef = useRef(onUserInput);
  useEffect(() => {
    onUserInputRef.current = onUserInput;
  }, [onUserInput]);
  // WebGL renderer lifecycle. Only the ACTIVE terminal holds a GPU context;
  // hidden ones release it. These refs let the active-change effect drive
  // ensure/teardown without re-running (and tearing down) the main setup
  // effect. webglFailsRef caps how many times we rebuild after a context loss.
  const webglRef = useRef<WebglAddon | null>(null);
  const webglFailsRef = useRef(0);
  const ensureWebglRef = useRef<() => void>(() => {});
  const teardownWebglRef = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: TERM_FONT_FAMILY,
      fontSize: TERM_FONT_SIZE,
      lineHeight: TERM_LINE_HEIGHT,
      cursorBlink: true,
      theme: { background: '#0b0e14', foreground: '#c5c8d6' },
      scrollback: 5000,
      allowProposedApi: true,
      // claude's TUI turns on mouse reporting, so a plain drag is sent to
      // claude instead of selecting text — you can't select (hence can't
      // copy). This lets holding Option (⌥) force a local text selection
      // even while the app owns the mouse. Option+drag → selection →
      // copy-on-select writes it to the clipboard.
      macOptionClickForcesSelection: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    // the stream view reads this screen to find claude's own pickers
    registerTerm(sessionId, term);
    searchRef.current = search;
    const resSub = search.onDidChangeResults((r) =>
      setFindRes({ index: r.resultIndex, count: r.resultCount }),
    );
    // WebGL renderer lifecycle. The WebGL addon builds a per-terminal glyph
    // atlas on the GPU — crisp, evenly-weighted text (esp. on non-Retina
    // secondaries). But each live terminal holds a WebGL context and the
    // WebView caps how many can exist at once (~16); this app keeps every
    // session's <Term> mounted for its whole life, so with several sessions
    // open on a 4K panel the WebView evicts the oldest contexts and their
    // glyph atlases corrupt — text "花屏" after a while. Fix: only the ACTIVE
    // terminal holds a context (hidden ones release it and fall back to the
    // invisible DOM renderer), and a lost context is rebuilt instead of
    // permanently killing the renderer. MAX_WEBGL_RETRIES caps rebuilds so a
    // machine that genuinely can't do WebGL settles on the DOM renderer.
    const MAX_WEBGL_RETRIES = 3;
    const teardownWebgl = (): void => {
      const webgl = webglRef.current;
      if (!webgl) return;
      webglRef.current = null;
      try {
        webgl.dispose();
      } catch {
        /* already disposed */
      }
    };
    const ensureWebgl = (): void => {
      if (webglRef.current) return;
      if (webglFailsRef.current > MAX_WEBGL_RETRIES) return; // stay on DOM
      // Phones/tablets: mobile Safari/Chrome drop WebGL contexts freely
      // (backgrounding, memory pressure, orientation) and the terminal blinks
      // in and out while we rebuild — the DOM renderer is steady there and
      // fast enough for one visible pane.
      if (window.matchMedia('(pointer: coarse)').matches) return;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          // Lost context (GPU reset / WebView evicted it because too many
          // exist) → its atlas is gone/corrupt. Drop it; rebuild only if
          // we're still the visible terminal, else wait until reactivated.
          webglFailsRef.current += 1;
          teardownWebgl();
          if (activeRef.current) ensureWebgl();
        });
        term.loadAddon(webgl);
        webglRef.current = webgl;
      } catch {
        webglFailsRef.current += 1; // no context available — DOM renderer
      }
    };
    ensureWebglRef.current = ensureWebgl;
    teardownWebglRef.current = teardownWebgl;
    if (activeRef.current) ensureWebgl();

    // A devicePixelRatio change — window dragged between the 4K panel and a
    // 1x display, or the OS display scaling changed — invalidates the glyph
    // atlas; the WebGL renderer can keep drawing stale/mis-scaled glyphs. Clear
    // it explicitly, then re-arm the watcher for the new ratio.
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = (): void => {
      webglRef.current?.clearTextureAtlas();
      armDprWatch();
    };
    function armDprWatch(): void {
      dprQuery?.removeEventListener('change', onDprChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener('change', onDprChange);
    }
    armDprWatch();

    // WebGL + scrollback: the renderer repaints only the rows it believes
    // changed. Scrolling a viewport full of wide glyphs (CJK, box drawing)
    // occasionally leaves one row carrying pixels from the frame before — a
    // stray digit inside a table cell, a border segment past the table's right
    // edge. The buffer itself is right: scroll the row out of view and back
    // and it repaints correctly, which is what rules out bad data and points
    // at the damage tracking dropping a row. So repaint the whole viewport
    // after a scroll settles. One rAF-coalesced refresh no matter how many
    // scroll events a flick fires, and only while this terminal actually holds
    // a WebGL context — the DOM renderer doesn't have the bug and shouldn't
    // pay for it.
    let repaintRaf = 0;
    const repaintViewport = (): void => {
      if (!webglRef.current || repaintRaf) return;
      repaintRaf = requestAnimationFrame(() => {
        repaintRaf = 0;
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          /* disposed mid-frame */
        }
      });
    };
    const scrollSub = term.onScroll(repaintViewport);

    try {
      fit.fit();
    } catch {
      /* host not measured yet */
    }

    // Touch devices: the terminal is DISPLAY-ONLY. All typing goes through
    // the relay input in the MobileKeys bar (see relayInput.ts) — xterm's
    // hidden textarea is permanently inputmode=none and never receives text,
    // so none of its focus/value bookkeeping can swallow keystrokes. Taps
    // stay taps (links, selection); the tap-zone below decides whether the
    // relay gets focus (keyboard) or loses it.
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (coarse) term.textarea?.setAttribute('inputmode', 'none');

    // Copy support. With the WebGL renderer the terminal selection lives on a
    // canvas, not a DOM selection, so the webview's native Cmd+C copies
    // nothing. We write term.getSelection() to the clipboard ourselves — on
    // selection (copy-on-select) and on Cmd+C / Ctrl+Shift+C; plain Ctrl+C is
    // left alone so it still sends SIGINT. Under Tauri the WKWebview blocks
    // navigator.clipboard/execCommand, so we route through the clipboard-
    // manager plugin; the browser dev preview uses the web APIs. (Hold Option
    // to select — see macOptionClickForcesSelection — since claude's mouse
    // reporting otherwise consumes the drag.)
    //
    // Paste is deliberately left to xterm's own handler: the DOM paste event
    // carries the clipboard text fine, whereas the plugin's readText round-
    // trip is unreliable in this webview.
    const isTauri =
      typeof window !== 'undefined' &&
      'isTauri' in window &&
      Boolean((window as { isTauri?: boolean }).isTauri);
    const writeClipboard = (text: string): void => {
      if (!text) return;
      if (isTauri) {
        void import('@tauri-apps/plugin-clipboard-manager')
          .then((m) => m.writeText(text))
          .catch(() => {
            /* plugin unavailable */
          });
        return;
      }
      const fallback = (): void => {
        // execCommand copies whatever is SELECTED, so a scratch textarea has
        // to take focus for a moment — and it used to keep it: the element
        // was removed with focus left on <body>, so the terminal stopped
        // receiving keys. In a remote browser this is the ONLY copy path
        // (plain-http LAN has no navigator.clipboard, and copy-on-select has
        // no gesture for it), which is why "select, copy, then Cmd+V" pasted
        // nowhere — the paste went to <body>. Put focus back where it was.
        const prev = document.activeElement as HTMLElement | null;
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        } catch {
          /* clipboard unavailable */
        } finally {
          prev?.focus?.({ preventScroll: true });
        }
      };
      try {
        if (navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(text).catch(fallback);
        } else {
          fallback();
        }
      } catch {
        fallback();
      }
    };
    const copySelection = (): void => writeClipboard(term.getSelection());

    // Pictures on the paste. xterm's own paste handler reads only text, and
    // claude's Ctrl+V reads the clipboard of the machine claude runs on — so
    // from a remote browser a screenshot went nowhere at all. Take it off the
    // DOM paste event (see pasteImages.ts), upload it to the Mac, and type the
    // path into the prompt, which is how claude takes an image. Text-only
    // pastes are not touched: xterm handles those (bracketed paste and all).
    const onPaste = (e: ClipboardEvent): void => {
      const images = imageFilesFrom(e.clipboardData);
      if (images.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (readOnlyRef.current || pendingHandoffRef.current) return;
      void (async () => {
        const paths: string[] = [];
        for (const f of images) {
          if (f.size > PASTE_MAX_BYTES) continue;
          try {
            const up = await rpc.request('file.upload', {
              name: pastedName(f),
              base64: await fileBase64(f),
            });
            paths.push(up.path);
          } catch {
            /* an upload that fails leaves the prompt as it was */
          }
        }
        if (paths.length === 0) return;
        onUserInputRef.current?.(sessionId);
        await rpc.request('session.input', { sessionId, data: `${paths.join(' ')} ` });
      })();
    };
    host.addEventListener('paste', onPaste, { capture: true });
    const selSub = term.onSelectionChange(copySelection);
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const key = e.key.toLowerCase();
      // Cmd+F (mac) / Ctrl+F when NOT at a shell prompt is ambiguous, so scope
      // to Cmd+F: open the find bar instead of forwarding ^F to the PTY.
      if (e.metaKey && !e.ctrlKey && key === 'f') {
        setFindOpen(true);
        return false;
      }
      const isCopy =
        (e.metaKey && !e.ctrlKey && key === 'c') || (e.ctrlKey && e.shiftKey && key === 'c');
      if (isCopy && term.hasSelection()) {
        copySelection();
        return false; // handled — don't forward ^C to the PTY
      }
      return true;
    });

    // Wheel handling in the ALTERNATE buffer (claude TUI). The alt buffer has
    // no scrollback, so xterm's default viewport scroll would just expose
    // stale main-screen rows and make the live frame "底部消失".
    //
    // Modern claude enables mouse reporting (mouseTrackingMode != 'none') and
    // scrolls its OWN conversation when it receives wheel-as-mouse events. In
    // that case we must do NOTHING here and let xterm encode + forward the
    // wheel — intercepting it (and sending ↑/↓) is exactly what broke after a
    // claude update repurposed the arrow keys for input-history navigation:
    // scrolling started moving through the input box instead of the chat.
    //
    // Only for an OLDER claude that doesn't report the wheel do we fall back
    // to emulating scroll via arrow-key presses. Capture phase so we beat
    // xterm's internal listener when we do act. Normal buffer: untouched,
    // regular scrollback works as usual.
    let arrowAcc = 0; // px of wheel not yet converted into an arrow key
    const onWheel = (e: WheelEvent): void => {
      if (term.buffer.active.type !== 'alternate') return;
      if (term.modes.mouseTrackingMode !== 'none') return; // claude scrolls itself
      e.preventDefault();
      e.stopPropagation();
      // ACCUMULATE and emit one arrow per 40px. The old "min 1 per event"
      // fired an arrow for every few-pixel wheel/touch event — on touch that
      // meant dozens of keys per swipe: way too fast and visibly jerky.
      arrowAcc = Math.sign(e.deltaY) === Math.sign(arrowAcc) ? arrowAcc + e.deltaY : e.deltaY;
      const steps = Math.min(8, Math.trunc(Math.abs(arrowAcc) / 40));
      if (steps === 0) return;
      const key = arrowAcc > 0 ? '\x1b[B' : '\x1b[A'; // down : up
      arrowAcc -= Math.sign(arrowAcc) * steps * 40;
      if (!readOnlyRef.current && !pendingHandoffRef.current) {
        void rpc.request('session.input', { sessionId, data: key.repeat(steps) });
      }
    };
    host.addEventListener('wheel', onWheel, { capture: true, passive: false });

    // Touch scrolling: xterm has none of its own, so a swipe on a phone did
    // nothing (or pulled-to-refresh). Convert touch moves into synthetic
    // wheel events on the same element — every existing wheel path (normal
    // buffer scrollback, alt-buffer arrow emulation above, claude's own
    // mouse-wheel reports) then works for touch too.
    let touchY: number | null = null;
    let tapStart: { x: number; y: number } | null = null;
    let velocity = 0; // px/ms, momentum after the finger lifts
    let lastMoveAt = 0;
    let momentumRaf = 0;
    let wheelAcc = 0; // finger travel (px) not yet turned into wheel events
    /** One row of the terminal, in CSS px — the unit a wheel event is worth.
     *  Falls back to the configured line height before the host is measured:
     *  an unmeasured host would otherwise make a row ~0px and turn every pixel
     *  of finger travel into a wheel event. */
    const rowPx = (): number => {
      const h = host.clientHeight / Math.max(1, term.rows);
      return h >= 8 ? h : TERM_FONT_SIZE * TERM_LINE_HEIGHT;
    };
    const emitWheel = (delta: number): void => {
      // Plain accumulation. The old code DISCARDED the accumulator whenever
      // the sign flipped, so the jitter in a slow drag kept throwing away
      // travel the finger had already covered.
      wheelAcc += delta;
      const { steps, deltaY, rest } = takeWheelSteps(wheelAcc, rowPx(), MAX_WHEEL_STEPS);
      wheelAcc = rest;
      if (steps === 0) return;
      // ONE EVENT PER ROW, not one fat event: xterm turns a wheel event into
      // at most a SINGLE wheel report however large deltaY is (bindMouse in
      // Terminal.ts bails after one), so batching 60px of a fast swipe into
      // one event scrolled a single row and dropped the rest — the swipe
      // never tracked the finger. Capped so a wild flick can't flood the PTY.
      //
      // Dispatch on term.element, NEVER on the touch's own target: a touch
      // target is captured at touchstart and a TUI repaint replaces the span
      // under the finger within milliseconds, so the events went to a node
      // that had left the document and the whole gesture silently did nothing
      // (scrolling "worked" only when the finger landed on blank row space).
      // term.element carries xterm's own wheel listener and still bubbles to
      // the host handler above.
      const target = term.element ?? host;
      for (let i = 0; i < steps; i++) {
        target.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
      }
    };
    const onTouchStart = (e: TouchEvent): void => {
      cancelAnimationFrame(momentumRaf);
      velocity = 0;
      wheelAcc = 0; // a new gesture starts from zero, not from the last one's remainder
      touchY = e.touches[0]?.clientY ?? null;
      lastMoveAt = e.timeStamp;
      const t = e.touches[0];
      tapStart = t ? { x: t.clientX, y: t.clientY } : null;
    };
    const onTouchMove = (e: TouchEvent): void => {
      const y = e.touches[0]?.clientY;
      if (touchY === null || y === undefined) return;
      const delta = touchY - y; // finger up → positive → scroll down (natural)
      touchY = y;
      e.preventDefault();
      const dt = Math.max(1, e.timeStamp - lastMoveAt);
      lastMoveAt = e.timeStamp;
      // blend for a stable read of the finger's speed (raw per-event deltas jitter)
      velocity = 0.8 * (delta / dt) + 0.2 * velocity;
      emitWheel(delta); // 1:1 while the finger is down — tracks, no jumping
    };
    const startMomentum = (): void => {
      if (Math.abs(velocity) < 0.08) return;
      const step = (): void => {
        const delta = velocity * 16; // one 60fps frame's worth
        if (Math.abs(delta) < 0.7) return;
        emitWheel(delta);
        velocity *= 0.94;
        momentumRaf = requestAnimationFrame(step);
      };
      momentumRaf = requestAnimationFrame(step);
    };
    // Tap position decides the keyboard (no mode toggle): a tap on the agent's
    // input box — or anywhere below it — opens the soft keyboard for direct
    // typing; a tap on the conversation above is just a tap (links, selection)
    // and DISMISSES an open keyboard. Swipes (moved > 10px) never count.
    //
    // The zone follows the CURSOR, because that is where the input box is.
    // Anchoring it to the terminal's bottom edge was wrong: the box does not
    // sit on that edge — blank rows follow it — so tapping the box you can SEE
    // counted as "above the zone" and actively dismissed the keyboard, and the
    // only spot that opened it was the empty space underneath.
    const KEYBOARD_ZONE_PX = 90;
    const tapIntent = (clientY: number, rect: DOMRect) =>
      keyboardTapIntent({
        tapY: clientY,
        hostTop: rect.top,
        hostBottom: rect.bottom,
        rowPx: rowPx(),
        cursorY: term.buffer.active.cursorY,
        rows: term.rows,
        bottomStripPx: KEYBOARD_ZONE_PX,
      });
    const onTouchEnd = (e: TouchEvent): void => {
      touchY = null;
      const start = tapStart;
      tapStart = null;
      if (!start) return;
      const t = e.changedTouches[0];
      if (!t || Math.abs(t.clientX - start.x) > 10 || Math.abs(t.clientY - start.y) > 10) {
        startMomentum(); // it was a swipe — let it glide
        return;
      }
      const ta = term.textarea;
      if (!ta) return;
      // suppress the browser's OWN simulated mouse sequence for this tap:
      // its mousedown lands on a non-focusable div and blurs the textarea we
      // are about to focus — in Chrome the keyboard collapsed right after
      // opening. We synthesize the click ourselves below instead.
      e.preventDefault();
      const rect = host.getBoundingClientRect();
      // xterm swallows touches, so a tap never becomes a mouse click on its
      // own — synthesize mousedown/mouseup at the tap point so the TUI's
      // clickable spots ("jump to end" etc.) receive a real click report.
      const opts = {
        clientX: t.clientX,
        clientY: t.clientY,
        button: 0,
        bubbles: true,
        cancelable: true,
        detail: 1,
      } as const;
      // term.element for the same reason as the wheel events: the touch's own
      // target is captured at touchstart and a TUI repaint has usually already
      // replaced it, so the click went to a node outside the document. The
      // report is built from clientX/clientY, not from the target.
      const clickTarget = term.element ?? host;
      clickTarget.dispatchEvent(new MouseEvent('mousedown', opts));
      clickTarget.dispatchEvent(new MouseEvent('mouseup', opts));
      // The synthesized click above may have focused xterm's textarea; it is
      // display-only on touch (inputmode=none) so no keyboard pops, but a
      // focused hidden field still shows a stray caret — drop that focus.
      if (document.activeElement === ta) ta.blur();
      const intent = tapIntent(t.clientY, rect);
      if (intent === 'type') {
        // tapping the agent's input box = typing: focus the relay input in
        // the key bar (that's what opens the soft keyboard now)
        focusRelayInput();
      } else if (intent === 'read') {
        // tapping the conversation = reading: dismiss the keyboard
        blurRelayInput();
      }
      // 'neither': the frame cannot say where the box is — change nothing.
    };
    host.addEventListener('touchstart', onTouchStart, { passive: true });
    host.addEventListener('touchmove', onTouchMove, { passive: false });
    host.addEventListener('touchend', onTouchEnd, { passive: false });

    // Attach replay: this terminal may mount long after the session started
    // (a phone over LAN/relay, a second window). Write the raw tail first and
    // ignore live chunks until it has landed — those chunks are already inside
    // the snapshot (the server takes it after our subscription is live), so
    // queueing them would paint the same bytes twice. A TUI repaints
    // constantly; the sub-RTT sliver between snapshot and arrival is moot.
    let replaying = true;
    /** Adopt the PTY's winsize. Only for a terminal that cannot measure itself:
     *  while this Term is hidden (`display:none` — the whole time the session
     *  is shown in the stream view) the fit addon can propose nothing, so xterm
     *  silently sits at its 80×24 default while the PTY runs at whatever the
     *  visible client set. Every frame claude draws then wraps into nonsense,
     *  which is why the stream view's picker reader found no /model options on
     *  a phone: the option lines and the footer fell off a 24-row screen. When
     *  this Term IS visible, fit() owns the size and must not be second-guessed. */
    const adoptPtySize = (cols?: number, rows?: number): void => {
      if (activeRef.current || !cols || !rows) return;
      if (term.cols === cols && term.rows === rows) return;
      try {
        term.resize(cols, rows);
      } catch {
        /* emulator busy — the next session.size will carry the same numbers */
      }
    };
    void rpc
      .request('session.raw', { sessionId })
      .then((r) => {
        // BEFORE the write: a tail replayed at the wrong width is wrapped for
        // good, and no later resize un-wraps it
        adoptPtySize(r.cols, r.rows);
        if (r.raw) term.write(r.raw);
      })
      .catch(() => {})
      .finally(() => {
        replaying = false;
      });
    const offSize = rpc.on('session.size', (d) => {
      if (d.sessionId !== sessionId) return;
      adoptPtySize(d.cols, d.rows);
    });
    const offOut = rpc.on('session.output', (d) => {
      if (d.sessionId !== sessionId || replaying) return;
      term.write(d.chunk, () => {
        // auto-tail ONLY in the normal buffer. When claude's TUI is in
        // the ALTERNATE screen buffer (full-screen UI: streaming
        // response, Ctrl-O expanded tool detail, etc.) it owns the whole
        // viewport and redraws every frame — our scrollToBottom() would
        // fight that redraw and make the bottom/input "disappear". The
        // alt buffer has no scrollback, so there's nothing to tail.
        if (!activeRef.current) return;
        if (term.buffer.active.type !== 'normal') return;
        const buf = term.buffer.active;
        if (buf.viewportY >= buf.baseY - 2) term.scrollToBottom();
      });
    });
    const offStatus = rpc.on('session.status', (d) => {
      if (d.sessionId === sessionId && d.state === 'exited') {
        term.write(
          `\r\n\x1b[2m[session exited${d.exitCode != null ? ` (${d.exitCode})` : ''}]\x1b[0m\r\n`,
        );
      }
    });
    // readOnly OR pendingHandoff: capture but DON'T forward — the user
    // can still copy/paste OUT, but typing into a frozen / handoff-locked
    // session has no effect. (We don't skip the listener entirely,
    // otherwise xterm wouldn't render the cursor / let text-select work.)
    const dataSub = term.onData((data) => {
      if (readOnlyRef.current || pendingHandoffRef.current) return;
      onUserInputRef.current?.(sessionId);
      void rpc.request('session.input', { sessionId, data });
    });
    // Coalesced: a soft keyboard sliding in or out resizes the host on every
    // animation frame, and forwarding each one handed the PTY a burst of
    // SIGWINCHs. claude redraws on each, and a redraw racing the next size
    // change leaves a mangled input box — the "2+ line input goes garbled" and
    // "input box disappears" reports. One fit + one resize once it settles.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    // a refit parked behind a drag must not fire into a torn-down terminal
    let gone = false;
    // Interaction is the signal — connecting is not. A phone left on a desk
    // must not squeeze this terminal; a click, a tap or returning to the window
    // must take it back, reflowing exactly like dragging the window wider.
    const claim = (): void => {
      if (!activeRef.current) return;
      // activate alone is enough: the server remembers the size THIS client
      // last reported for the session and applies it on handover. Re-fitting
      // here ran a layout measurement on every tap and every swipe start,
      // which on a phone is both wasted work and a chance to jar the scroll.
      void rpc.request('session.activate', { sessionId }).catch(() => {});
    };
    host.addEventListener('mousedown', claim, { capture: true });
    host.addEventListener('touchstart', claim, { capture: true, passive: true });
    window.addEventListener('focus', claim);

    const ro = new ResizeObserver((entries) => {
      // ignore the 0×0 burst that happens while the Term is hidden
      // (display:none) — fitting then collapses the terminal to invalid
      // dims and the next refit can leave the viewport past the bottom.
      const r = entries[0]?.contentRect;
      if (!r || r.width < 8 || r.height < 8) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        // Held until the pane drag lets go: every size we hand the PTY costs
        // one claude redraw, and a redraw landing mid-reflow strands the
        // previous frame at the old width forever (see resizeGate).
        afterDrag(() => {
          if (gone) return;
          try {
            // If the user was reading the live tail, keep them ON the tail.
            // A refit shifts viewportY; landing >2 rows from the bottom
            // silently disarms the output auto-tail, which on a phone is
            // the whole bug: keyboard opens → host shrinks → refit → echo
            // of every keystroke lands below a viewport that no longer
            // follows. Reading history (not at bottom) is left alone.
            const buf = term.buffer.active;
            const wasAtBottom = buf.viewportY >= buf.baseY - 2;
            fit.fit();
            if (wasAtBottom && term.buffer.active.type === 'normal') term.scrollToBottom();
            void rpc.request('session.resize', { sessionId, cols: term.cols, rows: term.rows });
          } catch {
            /* not visible */
          }
        });
      }, RESIZE_SETTLE_MS);
    });
    ro.observe(host);

    // Make URLs + paths in the terminal clickable. Three traps this handles
    // that a naive per-row translateToString scan does not:
    //   • WIDE CHARS: a CJK glyph is ONE string char but TWO columns — any
    //     line with Chinese before the link shifted every column, so the
    //     underline sat askew and the click region missed the visible text.
    //     We walk the cells and map every code unit to its real column.
    //   • WRAPPED LINES: long URLs wrap; matching row-by-row truncated them.
    //     We assemble the logical line (isWrapped chain) and emit ranges
    //     that span rows.
    //   • URLS AT ALL: the old regex only knew filesystem paths.
    const buildLogicalLine = (
      startIdx: number,
    ): { text: string; pos: { x: number; y: number }[] } => {
      const buf = term.buffer.active;
      let text = '';
      const pos: { x: number; y: number }[] = []; // per code unit → 1-based col/row
      for (let idx = startIdx; ; idx++) {
        const line = buf.getLine(idx);
        if (!line) break;
        for (let col = 0; col < line.length; col++) {
          const cell = line.getCell(col);
          if (!cell || cell.getWidth() === 0) continue; // wide-char continuation
          const s = cell.getChars() || ' ';
          for (let k = 0; k < s.length; k++) pos.push({ x: col + 1, y: idx + 1 });
          text += s;
        }
        if (!buf.getLine(idx + 1)?.isWrapped) break;
      }
      let end = text.length;
      while (end > 0 && text[end - 1] === ' ') end--;
      return { text: text.slice(0, end), pos: pos.slice(0, end) };
    };

    // Paths cut by a HARD wrap. claude's TUI wraps long lines itself — a real
    // newline and an indent — so xterm's soft-wrap chain never rejoins them,
    // and a long path arrives in pieces: most of the filename on the second
    // row, the head of a relative path not even recognisable as a link. The
    // old code only extended a link found on the FIRST row, and hid the second
    // row's piece on a guess — so clicking the filename did nothing, and a
    // wrapped relative path pointed at its own tail. termWrap.ts assembles the
    // whole token from whichever row is asked; the disk decides whether it is
    // one path (geometry alone would also glue a complete path that ended at
    // the edge to the prose below it — CJK counts as path characters). Only a
    // confirmed token becomes a link, and on-screen wraps are confirmed in the
    // background as output settles, so the first hover is already right.
    /** Rows that are their own logical line. A hard wrap is only ever made of
     *  these; a row xterm soft-wrapped belongs to its logical line instead. */
    const plainRowAt = (index: number): RowText | undefined => {
      const buf = term.buffer.active;
      const line = buf.getLine(index);
      if (!line || line.isWrapped || buf.getLine(index + 1)?.isWrapped) return undefined;
      return buildLogicalLine(index);
    };
    type Confirmed = { path: string; token: WrappedToken } | null;
    const confirmed = new Map<string, Confirmed>();
    const inFlight = new Set<string>();
    /** The joined text is part of the key: claude redraws constantly, and a
     *  verdict for one set of rows must not carry over to another. */
    const tokenKey = (t: WrappedToken): string => `${t.start.y}:${t.start.x}:${t.end.y}:${t.text}`;
    const confirmToken = (t: WrappedToken): void => {
      const key = tokenKey(t);
      if (confirmed.has(key) || inFlight.has(key)) return;
      inFlight.add(key);
      void rpc
        .request('path.resolve', { sessionId, ref: t.text.replace(TRAIL_RE, '') })
        .catch(() => null)
        .then((res) => {
          if (confirmed.size > 500) confirmed.clear(); // keys are row text; old ones are dead weight
          confirmed.set(key, res?.path ? { path: res.path, token: t } : null);
          inFlight.delete(key);
        });
    };
    /** The confirmed wrapped path touching a row, if any — asking for one
     *  that has not been checked yet starts the check. */
    const wrappedLinkAt = (index: number): Confirmed => {
      const t = wrappedTokenAt(index, term.cols, plainRowAt);
      if (!t) return null;
      const hit = confirmed.get(tokenKey(t));
      if (hit === undefined) confirmToken(t);
      return hit ?? null;
    };
    // background: confirm every wrap on screen once output stops arriving
    let scanTimer: ReturnType<typeof setTimeout> | undefined;
    const scanViewport = (): void => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        if (gone) return;
        const buf = term.buffer.active;
        for (let i = buf.viewportY; i < buf.viewportY + term.rows; i++) wrappedLinkAt(i);
      }, 250);
    };
    const parsedSub = term.onWriteParsed(scanViewport);
    const wrapScrollSub = term.onScroll(scanViewport);

    const linkDisposable = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const buf = term.buffer.active;
        let startIdx = bufferLineNumber - 1;
        if (!buf.getLine(startIdx)) {
          callback(undefined);
          return;
        }
        while (startIdx > 0 && buf.getLine(startIdx)?.isWrapped) startIdx--;
        const { text, pos } = buildLogicalLine(startIdx);
        const links: ILink[] = [];
        // a path wrapped across rows, confirmed on disk: one link over all of
        // it, offered from every row it touches
        const wrapped = wrappedLinkAt(bufferLineNumber - 1);
        const inWrapped = (c: { x: number; y: number }): boolean => {
          if (!wrapped) return false;
          const { start, end } = wrapped.token;
          const after = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
            a.y > b.y || (a.y === b.y && a.x >= b.x);
          return after(c, start) && after(end, c);
        };
        if (wrapped) {
          const loc = /^:(\d+)(?::(\d+))?/.exec(wrapped.token.after);
          const line = loc?.[1] ? Number(loc[1]) : undefined;
          const column = loc?.[2] ? Number(loc[2]) : undefined;
          links.push({
            range: { start: wrapped.token.start, end: wrapped.token.end },
            text: wrapped.path,
            activate: () => onOpenPathRef.current?.(wrapped.path, cwdRef.current, line, column),
          });
        }
        // WHAT counts as a link on a single row is decided by the pure
        // findLinks() (spans, location suffixes, overlaps — termLinks.test.ts);
        // everything here is terminal geometry, which only this file knows.
        for (const span of findLinks(text)) {
          const start = pos[span.start];
          const endCell = pos[span.end - 1];
          if (!start || !endCell) continue;
          // a piece of the confirmed wrapped path is not a link of its own
          if (span.kind === 'path' && (inWrapped(start) || inWrapped(endCell))) continue;
          // the provider is asked per row — only report links touching it
          if (bufferLineNumber < start.y || bufferLineNumber > endCell.y) continue;
          const { kind, target, line, column } = span;
          links.push({
            range: { start, end: endCell },
            text: target,
            activate: () => {
              if (kind === 'url') void rpc.request('url.open', { url: target });
              else onOpenPathRef.current?.(target, cwdRef.current, line, column);
            },
          });
        }
        callback(links.length > 0 ? links : undefined);
      },
    });

    return () => {
      gone = true;
      unregisterTerm(sessionId);
      offOut();
      offStatus();
      offSize();
      dataSub.dispose();
      selSub.dispose();
      resSub.dispose();
      ro.disconnect();
      clearTimeout(resizeTimer);
      linkDisposable.dispose();
      parsedSub.dispose();
      wrapScrollSub.dispose();
      clearTimeout(scanTimer);
      host.removeEventListener('wheel', onWheel, { capture: true });
      host.removeEventListener('paste', onPaste, { capture: true });

      host.removeEventListener('mousedown', claim, { capture: true });
      host.removeEventListener('touchstart', claim);
      window.removeEventListener('focus', claim);
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('touchmove', onTouchMove);
      host.removeEventListener('touchend', onTouchEnd);
      cancelAnimationFrame(momentumRaf);
      cancelAnimationFrame(repaintRaf);
      scrollSub.dispose();
      dprQuery?.removeEventListener('change', onDprChange);
      ensureWebglRef.current = () => {};
      teardownWebglRef.current = () => {};
      teardownWebgl();
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
    };
  }, [sessionId, rpc]);

  // run a search over the terminal buffer, highlighting matches
  const runFind = useCallback((q: string, dir: 'next' | 'prev', incremental = false): void => {
    const s = searchRef.current;
    if (!s) return;
    if (!q) {
      s.clearDecorations();
      setFindRes({ index: -1, count: 0 });
      return;
    }
    const opts = {
      decorations: {
        matchBackground: '#33415a',
        matchBorder: '#3a4359',
        matchOverviewRuler: '#6aa8e0',
        activeMatchBackground: '#6aa8e0',
        activeMatchBorder: '#82bff5',
        activeMatchColorOverviewRuler: '#82bff5',
      },
      incremental,
    };
    if (dir === 'next') s.findNext(q, opts);
    else s.findPrevious(q, opts);
  }, []);

  const closeFind = useCallback(() => setFindOpen(false), []);

  // focus the find input when it opens; clear highlights + refocus term on close
  useEffect(() => {
    if (findOpen) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    } else {
      searchRef.current?.clearDecorations();
      setFindRes({ index: -1, count: 0 });
      if (active) termRef.current?.focus();
    }
  }, [findOpen, active]);

  // incremental find as the query changes
  useEffect(() => {
    if (findOpen) runFind(findQuery, 'next', true);
  }, [findQuery, findOpen, runFind]);

  // refit + focus + snap to bottom + push size when this session becomes
  // the active one. snapToBottom is essential: while the Term was hidden
  // (display:none) we still received output, and a freshly-shown viewport
  // can end up above the live tail if the user had scrolled earlier or
  // the reflow on fit moved things. Snapping guarantees the prompt + last
  // output are visible the moment you switch in.
  useEffect(() => {
    // The visible terminal gets the GPU renderer; a hidden one releases its
    // WebGL context so many mounted sessions can't exhaust the WebView's
    // context limit and corrupt each other's glyph atlases.
    if (active) ensureWebglRef.current();
    else teardownWebglRef.current();
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    if (!active) {
      // Touch: input lives in the App-level relay (relayInput.ts), which a
      // session switch never touches — the keyboard survives the switch and
      // keystrokes go wherever `focused` points. Only housekeeping here: a
      // synthesized click may have focused this terminal's display-only
      // textarea; don't let a hidden terminal keep that focus.
      if (window.matchMedia('(pointer: coarse)').matches) {
        const ta = term.textarea;
        if (ta && document.activeElement === ta) ta.blur();
      }
      return;
    }
    const t = setTimeout(() => {
      try {
        fit.fit();
        remeasureViewport(term);
        // Only snap to bottom in the normal buffer. In the alt buffer
        // (claude TUI), scrollToBottom corrupts the full-screen frame —
        // claude positions its own cursor, so switching INTO a streaming
        // session must leave the viewport exactly where claude drew it.
        if (term.buffer.active.type === 'normal') term.scrollToBottom();
        // Touch: the keyboard belongs to the TAP handler, never to us. Taking
        // focus here is what broke it — this effect runs inside the tap that
        // picked the session, so unlike the ignored focus at mount the browser
        // honours it, and the textarea ends up focused while still
        // inputmode=none. The user's tap on the input strip is then not a
        // focus CHANGE, the browser never re-reads inputmode, and the keyboard
        // refuses to open. Leaving focus alone makes every session behave like
        // the first one, where the mount-time focus is ignored anyway.
        if (!window.matchMedia('(pointer: coarse)').matches) term.focus();
        // Claim the layout before reporting our size: a PTY has one winsize,
        // and whoever is looking at the session should be the one it fits.
        // Without this the desktop kept rendering a frame laid out for a phone
        // that had glanced at the session hours ago (nothing re-asserted).
        void rpc.request('session.activate', { sessionId }).catch(() => {});
        void rpc.request('session.resize', { sessionId, cols: term.cols, rows: term.rows });
      } catch {
        /* ignore */
      }
    }, 0);
    return () => clearTimeout(t);
  }, [active, rpc, sessionId]);

  // Drag a file/dir from the Files panel onto the terminal → insert its path
  // into this session's input. In-webview (DOM) drags carry the path in the
  // dataTransfer; OS/Finder file drops don't expose a path here (Tauri handles
  // those at the App level), so a pathless drop just no-ops.
  const droppable = !readOnly && !pendingHandoff;
  const onDragOver = (e: React.DragEvent): void => {
    if (!droppable) return;
    const t = e.dataTransfer.types;
    if (t.includes(PATH_DRAG_MIME) || t.includes('text/plain') || t.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!dragActive) setDragActive(true);
    }
  };
  const onDrop = (e: React.DragEvent): void => {
    setDragActive(false);
    if (!droppable) return;
    const path = e.dataTransfer.getData(PATH_DRAG_MIME) || e.dataTransfer.getData('text/plain');
    if (!path) return; // OS file drop with no DOM path — handled natively by App
    e.preventDefault();
    const data = formatPathForInput(path);
    if (data) void rpc.request('session.input', { sessionId, data });
  };

  return (
    <>
      <div
        ref={hostRef}
        className={[
          'term-host',
          readOnly ? 'term-readonly' : '',
          style ? 'in-flex' : '',
          dragActive ? 'term-dragover' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ display: active ? 'block' : 'none', ...style }}
        onDragOver={onDragOver}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
      />
      {active && findOpen && (
        <div className="term-find">
          <input
            ref={findInputRef}
            className="term-find-input"
            placeholder="Find"
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                runFind(findQuery, e.shiftKey ? 'prev' : 'next');
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeFind();
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="term-find-count">
            {findRes.count
              ? `${findRes.index + 1}/${findRes.count}`
              : findQuery
                ? 'No results'
                : ''}
          </span>
          <button
            type="button"
            className="term-find-btn"
            onClick={() => runFind(findQuery, 'prev')}
            title="Previous (⇧⏎)"
          >
            ↑
          </button>
          <button
            type="button"
            className="term-find-btn"
            onClick={() => runFind(findQuery, 'next')}
            title="Next (⏎)"
          >
            ↓
          </button>
          <button type="button" className="term-find-btn" onClick={closeFind} title="Close (Esc)">
            ✕
          </button>
        </div>
      )}
      {active && pendingHandoff && (
        <div className="term-handoff-overlay" style={style}>
          <div className="term-handoff-card">
            <div className="term-handoff-spin" />
            <div className="term-handoff-title">Handoff in progress</div>
            <div className="term-handoff-sub">
              {humanName || 'This session'} is writing the handoff document.
              <br />
              The successor session will open here automatically.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
