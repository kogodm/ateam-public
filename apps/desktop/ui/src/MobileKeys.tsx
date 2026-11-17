import { useCallback, useEffect, useRef, useState } from 'react';
import { MOBILE_KEYS } from './mobile';
import { PermissionsButton } from './PermissionsButton';
import { registerRelayInput } from './relayInput';
import type { Rpc } from './rpc';

/** Touch key bar under the terminal on phones: the keys a soft keyboard
 *  lacks (Esc / Tab / Ctrl-C / arrows / Enter), a 📎 that uploads a photo to
 *  the desktop and pastes its path into the session, and ⌨ to pop the soft
 *  keyboard (focus xterm's hidden textarea). */
export function MobileKeys({
  rpc,
  sessionId,
  onSent,
}: {
  rpc: Rpc | null;
  sessionId: string;
  onSent?: () => void;
}): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  const relayRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');

  const send = useCallback(
    (seq: string) => {
      if (!rpc || !sessionId) return;
      void rpc.request('session.input', { sessionId, data: seq }).catch(() => {});
      onSent?.();
    },
    [rpc, sessionId, onSent],
  );

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f || !rpc || !sessionId) return;
      if (f.size > 15 * 1024 * 1024) {
        setBusy('too large (15MB max)');
        setTimeout(() => setBusy(''), 1500);
        return;
      }
      setBusy(`uploading ${f.name}…`);
      try {
        const base64 = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result).split(',')[1] ?? '');
          r.onerror = () => rej(r.error);
          r.readAsDataURL(f);
        });
        const up = await rpc.request('file.upload', { name: f.name, base64 });
        // paste the path (space-terminated) so the agent can read the image
        await rpc.request('session.input', { sessionId, data: `${up.path} ` });
        setBusy('attached');
        onSent?.();
      } catch (err) {
        // the file may have uploaded fine and only the input injection
        // failed (a dead sessionId after an app restart did this) — the
        // user must SEE it, not glimpse it for a second
        setBusy(`附件失败: ${err instanceof Error ? err.message : String(err)}`);
        setTimeout(() => setBusy(''), 6000);
        return;
      }
      setTimeout(() => setBusy(''), 1200);
    },
    [rpc, sessionId, onSent],
  );

  // The relay input: the ONLY way characters reach the PTY from a soft
  // keyboard. Plain text is forwarded from `beforeinput` and cancelled, so
  // the field never accumulates value — there is no bookkeeping for a focus
  // change or a session switch to corrupt (the exact class of bug that made
  // xterm's hidden-textarea path swallow characters). An IME composition is
  // the one thing allowed to live IN the field: the preview is visible right
  // in the input, and compositionend forwards the final string whole.
  //
  // Native listeners, not React props: the ordering guarantees between
  // beforeinput / composition events matter here, and React's synthetic
  // layer does not preserve them faithfully across mobile browsers.
  // Refs, not effect deps: `onSent` is a fresh lambda every App render, and
  // re-running this effect re-registers the listeners — which resets the
  // `composing` flag mid-composition on any stray re-render. Mount once,
  // read the live values through refs.
  const routeRef = useRef({ rpc, sessionId, onSent });
  routeRef.current = { rpc, sessionId, onSent };
  useEffect(() => {
    const el = relayRef.current;
    if (!el) return;
    registerRelayInput(el);
    let composing = false;
    // On-screen event trace (this build only): the exact input-event
    // sequence a real phone produces is the evidence we keep needing for
    // IME/dictation bugs — surface it in the busy line, terse, deduped.
    const ring: { tag: string; n: number }[] = [];
    let traceTimer: ReturnType<typeof setTimeout> | undefined;
    const trace = (tag: string): void => {
      const last = ring[ring.length - 1];
      if (last && last.tag === tag) last.n++;
      else {
        ring.push({ tag, n: 1 });
        if (ring.length > 7) ring.shift();
      }
      setBusy(ring.map((r) => (r.n > 1 ? `${r.tag}×${r.n}` : r.tag)).join(' '));
      clearTimeout(traceTimer);
      traceTimer = setTimeout(() => {
        ring.length = 0;
        setBusy('');
      }, 8000);
    };
    // Ordered + retried. Every keystroke is its own RPC; on a phone over the
    // relay a brief drop used to reject one call, the catch swallowed it,
    // and the user's sentence arrived with its MIDDLE missing. The chain
    // keeps character order (never send B before A landed) and each chunk
    // gets three tries before it is declared lost — loudly, via the busy
    // line, instead of silently.
    let sendQ: Promise<void> = Promise.resolve();
    const forward = (data: string): void => {
      const { rpc: r, sessionId: sid, onSent: cb } = routeRef.current;
      if (!r || !sid) return;
      sendQ = sendQ.then(async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            await r.request('session.input', { sessionId: sid, data });
            return;
          } catch {
            if (attempt >= 2) {
              setBusy(`input dropped: ${JSON.stringify(data)}`);
              setTimeout(() => setBusy(''), 2500);
              return;
            }
            await new Promise((res) => setTimeout(res, 250 * (attempt + 1)));
          }
        }
      });
      cb?.();
    };
    // --- dictation rescue ---------------------------------------------
    // iOS dictation streams in as marked text (a composition) but leaves
    // the composition DANGLING when speech ends: no compositionend until
    // some other input forces a commit — the user's exact report was
    // "type one character and everything I said finally goes through".
    // We can't forward marked text as it arrives (iOS revises earlier
    // words mid-speech), so: once the composition has been QUIET for a
    // while, was never touched by a keyboard key (dictation fires no
    // keydown; pinyin fires one per keystroke), and holds non-ASCII text,
    // forward it ourselves and remember what we sent so the eventual
    // compositionend / blur doesn't send it twice.
    let compKeydowns = 0;
    let flushedComposition = '';
    let finishedText = '';
    let finishedAt = 0;
    let dictTimer: ReturnType<typeof setTimeout> | undefined;
    const armDictWatchdog = (): void => {
      clearTimeout(dictTimer);
      if (!composing) return;
      dictTimer = setTimeout(() => {
        if (!composing || compKeydowns > 0) return;
        // zero keydowns is the whole test: every keyboard (pinyin included)
        // fires one per keystroke; dictation and handwriting fire none.
        // No script check — English dictation is just as dangling.
        const text = el.value;
        if (!text) return;
        const fresh = flushedComposition && text.startsWith(flushedComposition)
          ? text.slice(flushedComposition.length)
          : text;
        if (!fresh) return;
        flushedComposition = text;
        forward(fresh.replace(/\r?\n/g, '\r'));
        trace('WD✓');
      }, 1500);
    };
    /** Composition is over (compositionend or blur): send what the
     *  watchdog hasn't already sent, undo it if iOS revised the text. */
    const finishComposition = (text: string, via: string): void => {
      clearTimeout(dictTimer);
      compKeydowns = 0;
      const sent = flushedComposition;
      flushedComposition = '';
      finishedText = text;
      finishedAt = Date.now();
      if (!text) return;
      let out: string;
      if (text === sent) return; // watchdog already delivered all of it
      if (sent && text.startsWith(sent)) {
        out = text.slice(sent.length); // dictation continued after flush
      } else if (sent) {
        // iOS revised what we already forwarded: erase, resend final
        out = '\x7f'.repeat([...sent].length) + text;
      } else {
        out = text;
      }
      forward(out.replace(/\r?\n/g, '\r'));
      trace(via);
    };
    const onBeforeInput = (e: Event): void => {
      const ie = e as InputEvent;
      trace(`bi:${ie.inputType}`);
      if (composing || ie.isComposing || ie.inputType === 'insertCompositionText') {
        armDictWatchdog();
        return;
      }
      if (
        (ie.inputType === 'insertText' ||
          ie.inputType === 'insertFromPaste' ||
          // iOS autocorrect/QuickType replaces text via this type — it used
          // to land in the field unforwarded and get wiped by the next clear
          ie.inputType === 'insertReplacementText') &&
        ie.data
      ) {
        e.preventDefault();
        forward(ie.data.replace(/\r?\n/g, '\r'));
      } else if (ie.inputType === 'insertLineBreak') {
        e.preventDefault();
        forward('\r');
      } else if (ie.inputType === 'deleteContentBackward' && el.value === '') {
        // empty field: nothing local to delete — it means backspace for the
        // terminal. (With composition text present the IME edits the field.)
        e.preventDefault();
        forward('\x7f');
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (composing || e.isComposing || e.keyCode === 229) {
        compKeydowns++;
        armDictWatchdog();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        forward('\r');
      } else if (e.key === 'Backspace' && el.value === '') {
        e.preventDefault();
        forward('\x7f');
      }
    };
    const onCompStart = (): void => {
      composing = true;
      compKeydowns = 0;
      flushedComposition = '';
      trace('cs');
      armDictWatchdog();
    };
    const onCompUpdate = (): void => {
      armDictWatchdog();
    };
    const onCompEnd = (e: CompositionEvent): void => {
      composing = false;
      finishComposition(e.data || el.value, `ce:${(e.data || el.value).length}`);
      // clear on the next tick: some IMEs fire trailing input events against
      // the field in this same tick, and yanking the value under them
      // re-breaks what this design exists to fix
      setTimeout(() => {
        if (!composing) el.value = '';
      }, 0);
    };
    // Keyboard dismissed / focus moved with a composition still dangling
    // (dictation ended, user closed the keyboard without typing): commit
    // it ourselves — iOS tears the marked text down without telling us on
    // some paths. The finishedText guard keeps the normal
    // compositionend→blur pair from sending twice.
    const onBlur = (): void => {
      clearTimeout(dictTimer);
      const text = el.value;
      composing = false;
      if (text && !(text === finishedText && Date.now() - finishedAt < 800)) {
        finishComposition(text, 'blur✓');
      } else {
        trace('blur');
      }
      el.value = '';
    };
    // Sweeper: any input path we did NOT enumerate above (an exotic
    // inputType, a non-cancelable event) leaves its text sitting in the
    // field. Composition legitimately does too — so wait a beat, and only
    // flush what is still there with no composition in progress. Without
    // this, that text was cleared unsent: invisible character loss.
    let sweepTimer: ReturnType<typeof setTimeout> | undefined;
    const onInput = (e: Event): void => {
      trace(`in:${(e as InputEvent).inputType ?? '?'}`);
      if (composing) {
        armDictWatchdog();
        return;
      }
      clearTimeout(sweepTimer);
      sweepTimer = setTimeout(() => {
        if (composing || !el.value) return;
        forward(el.value.replace(/\r?\n/g, '\r'));
        el.value = '';
      }, 120);
    };
    el.addEventListener('beforeinput', onBeforeInput);
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('compositionstart', onCompStart);
    el.addEventListener('compositionupdate', onCompUpdate);
    el.addEventListener('compositionend', onCompEnd);
    el.addEventListener('blur', onBlur);
    return () => {
      registerRelayInput(null);
      clearTimeout(sweepTimer);
      clearTimeout(dictTimer);
      clearTimeout(traceTimer);
      el.removeEventListener('beforeinput', onBeforeInput);
      el.removeEventListener('input', onInput);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('compositionstart', onCompStart);
      el.removeEventListener('compositionupdate', onCompUpdate);
      el.removeEventListener('compositionend', onCompEnd);
      el.removeEventListener('blur', onBlur);
    };
  }, []);

  /** hold-to-repeat for arrows / delete, like a phone keyboard: first
   *  repeat after 400ms, then one every 60ms until the finger lifts.
   *  The initial press itself is delivered by onClick. */
  const repeatRef = useRef<{
    delay?: ReturnType<typeof setTimeout>;
    iv?: ReturnType<typeof setInterval>;
  }>({});
  const stopRepeat = useCallback(() => {
    const r = repeatRef.current;
    if (r.delay) clearTimeout(r.delay);
    if (r.iv) clearInterval(r.iv);
    repeatRef.current = {};
  }, []);
  const startRepeat = useCallback(
    (seq: string) => {
      stopRepeat();
      repeatRef.current.delay = setTimeout(() => {
        repeatRef.current.iv = setInterval(() => send(seq), 60);
      }, 400);
    },
    [send, stopRepeat],
  );

  /** ⤓ jump to the live tail: a quick burst of large synthetic wheel-downs —
   *  scrolls the normal buffer to its bottom and walks claude's history view
   *  back to the end (its own "jump to end" hint is not tappable on touch). */
  const jumpToEnd = useCallback(() => {
    const screen = document.querySelector<HTMLElement>(
      '.term-host[style*="display: block"] .xterm-screen',
    );
    if (!screen) return;
    let n = 0;
    const step = (): void => {
      screen.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 1200, bubbles: true, cancelable: true }),
      );
      if (++n < 12) requestAnimationFrame(step);
    };
    step();
  }, []);

  return (
    <div className="mkeys" role="toolbar" aria-label="Terminal keys">
      <div className="mkeys-input-row">
        <input
          ref={relayRef}
          className="mkeys-input"
          type="text"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
          placeholder="type to the agent…"
          aria-label="Terminal input"
        />
      </div>
      <div className="mkeys-row">
        <button
          type="button"
          className="mkey"
          onClick={() => fileRef.current?.click()}
          title="Attach a photo — uploads it to the desktop and pastes the path"
        >
          📎
        </button>
        <button
          type="button"
          className="mkey"
          onClick={jumpToEnd}
          title="Jump to the latest output"
        >
          ⤓
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => void onFile(e)}
        />
        <PermissionsButton rpc={rpc} sessionId={sessionId} className="mkey wide" onSent={onSent} />
        {MOBILE_KEYS.map((k) => (
          <button
            type="button"
            key={k.label}
            className={`mkey${k.wide ? ' wide' : ''}`}
            onClick={() => send(k.seq)}
            onPointerDown={k.repeat ? () => startRepeat(k.seq) : undefined}
            onPointerUp={k.repeat ? stopRepeat : undefined}
            onPointerLeave={k.repeat ? stopRepeat : undefined}
            onPointerCancel={k.repeat ? stopRepeat : undefined}
            onContextMenu={(e) => e.preventDefault()}
            title={k.title}
          >
            {k.label}
          </button>
        ))}
        {busy && <span className="mkeys-note">{busy}</span>}
      </div>
    </div>
  );
}
