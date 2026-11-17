import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface DropdownOption {
  value: string;
  label: string;
  /** optional status (`menu` / `attn` / `limit` / `busy`). Rendered as a
   *  coloured FRAME around this option's label rather than a glyph beside
   *  it — at this size a dot/ring is easy to miss and adds a column that
   *  makes every row jitter as statuses come and go. */
  dot?: string;
  /** optional avatar image (src) shown before the label */
  avatar?: string;
}

/** viewport margin kept free above/below the menu */
const EDGE = 8;
/** A menu whose left edge lands this close to the window edge snaps flush to
 *  it. The collapsed-nav's trigger sits 10px in, so the menu left a 10px strip
 *  of the terminal showing beside the project list — too thin to read as a
 *  deliberate gap, it just looked like the popover was leaking. */
const SNAP_LEFT = 24;

/** App-styled dropdown replacing the native <select> (whose OS-rendered option
 *  list can't be themed or animated). Trigger + custom popover list, dark-theme
 *  tokens, an expand animation, closes on outside-click / Escape / pick.
 *
 *  The MENU IS PORTALED to <body> and positioned fixed. Rendering it inside the
 *  trigger's subtree made it a hostage of whatever ancestors happened to be
 *  there: the collapsed-nav's own box, and — the reported bug — the stage's
 *  handoff overlay (`inset:0`, translucent, its own stacking context), which
 *  painted over the open project list. Same reason the file breadcrumb menu is
 *  portaled. Being fixed also lets it flip up / clamp to the viewport instead of
 *  being cut off at the bottom of the screen. */
export function Dropdown({
  value,
  options,
  onChange,
  className,
  title,
  placeholder = '',
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  /** merged onto the root — carries width/flex sizing from the call site */
  className?: string;
  title?: string;
  placeholder?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    minWidth: number;
    maxHeight: number;
    /** sitting flush against the window's left edge — squares that side off */
    flushLeft?: boolean;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  /** Place the menu under the trigger, or above it when the space below is
   *  too small; either way cap its height to what actually fits on screen. */
  const place = useCallback(() => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - EDGE;
    const above = r.top - EDGE;
    const flip = below < 160 && above > below;
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - r.width - EDGE));
    const flushLeft = left <= SNAP_LEFT;
    setPos({
      left: flushLeft ? 0 : left,
      ...(flip
        ? { bottom: Math.round(window.innerHeight - r.top + 5) }
        : { top: Math.round(r.bottom + 5) }),
      minWidth: Math.round(r.width),
      maxHeight: Math.max(120, Math.round((flip ? above : below) - 5)),
      ...(flushLeft ? { flushLeft } : {}),
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node;
      // the menu lives outside rootRef now — check both before closing
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    // a fixed menu doesn't follow its trigger; re-place on layout shifts and
    // give up if the trigger scrolls away underneath it
    const onScroll = (): void => place();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, place]);

  return (
    <div ref={rootRef} className={`dd${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className={`dd-trigger${open ? ' open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current?.avatar && <img className="dd-ava" src={current.avatar} alt="" />}
        <span className={`dd-label${current?.dot ? ` dd-status st-${current.dot}` : ''}`}>
          {current?.label ?? placeholder}
        </span>
        <span className="dd-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className={`dd-menu${pos.flushLeft ? ' flush-left' : ''}`}
            style={{
              left: pos.left,
              ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }),
              minWidth: pos.minWidth,
              maxHeight: pos.maxHeight,
            }}
          >
            {options.map((o) => (
              <button
                type="button"
                key={o.value}
                className={`dd-option${o.value === value ? ' on' : ''}`}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span className="dd-check" aria-hidden="true">
                  {o.value === value ? '✓' : ''}
                </span>
                {o.avatar && <img className="dd-ava" src={o.avatar} alt="" />}
                <span className={`dd-option-label${o.dot ? ` dd-status st-${o.dot}` : ''}`}>
                  {o.label}
                </span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
