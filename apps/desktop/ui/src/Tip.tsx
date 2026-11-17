import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { tipPosition } from './tipPosition';

/**
 * A small "!" beside a title that holds its explanation, so Settings reads as
 * names and controls instead of paragraphs. Hovering shows it (keyboard focus
 * too); there is nothing to click open. The popover is portalled to <body> and
 * placed from the icon's rect: Settings scrolls, and a scroll container clips
 * anything hanging off it (the same trap the network panel fell into twice).
 */
export function Tip({
  children,
  label = 'About this',
}: { children: ReactNode; label?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const iconRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const place = useCallback(() => {
    const icon = iconRef.current;
    const pop = popRef.current;
    if (!icon || !pop) return;
    setPos(
      tipPosition(
        icon.getBoundingClientRect(),
        { width: pop.offsetWidth, height: pop.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, []);
  // measured once the popover exists, before it paints
  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open, place]);
  // the page moving under a fixed popover would leave it pointing at nothing
  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <span className="tip">
      <span
        ref={iconRef}
        className="tip-icon"
        role="img"
        aria-label={label}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so a keyboard can read the tip too
        tabIndex={0}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        !
      </span>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="tip-pop"
            role="tooltip"
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
          >
            {children}
          </div>,
          document.body,
        )}
    </span>
  );
}
