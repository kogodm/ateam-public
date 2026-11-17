import { type RefObject, useEffect, useState } from 'react';

export interface Box {
  w: number;
  h: number;
}

/** Live content-box size (padding excluded) of the element behind `ref`;
 *  null until measured or while `active` is false. */
export function useContentBox(ref: RefObject<HTMLElement>, active = true): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) {
      setBox(null);
      return;
    }
    const measure = (): void => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight);
      const h = el.clientHeight - Number.parseFloat(cs.paddingTop) - Number.parseFloat(cs.paddingBottom);
      setBox((b) => (b && b.w === w && b.h === h ? b : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, active]);
  return box;
}

/** The size an image should be LAID OUT at for a given zoom: fit-to-stage
 *  (never above 1:1 at zoom 1, like max-width/height:100%) times `zoom`.
 *
 *  Why lay it out instead of `transform: scale()`: WebKit rasterises the
 *  element once at its layout size and scale() only stretches that bitmap,
 *  so a fitted-down screenshot goes soft the moment it is zoomed in (Chrome
 *  re-rasterises and hides the problem). Measured on a 1200px test card in
 *  Safari: scale() blurry with and without will-change, explicit size sharp.
 *  Giving the element its real size makes the browser resample from the
 *  decoded image every time. */
export function zoomedSize(natural: Box, stage: Box, zoom: number): { width: number; height: number } {
  const fit = Math.min(1, stage.w / natural.w, stage.h / natural.h);
  return { width: natural.w * fit * zoom, height: natural.h * fit * zoom };
}
