import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ALL_CHANNELS,
  type Channels,
  applyChannels,
  fmtBytes,
  hasAlpha,
  hexOf,
  pointerToPixel,
  sampleAt,
} from './imagePixels';
import { type Box, useContentBox, zoomedSize } from './zoomBox';

interface Props {
  src: string;
  mime: string;
  size: number;
  mtime?: string;
  name: string;
  zoom: number;
  pan: { x: number; y: number };
  pixelated: boolean;
  wrapRef: React.RefObject<HTMLDivElement>;
  onPanStart: (e: ReactMouseEvent) => void;
  onDouble: () => void;
}

interface Decoded {
  width: number;
  height: number;
  px: Uint8ClampedArray;
  alpha: boolean;
}

/** Image stage + info bar (#17): W×H / format / size / mtime / channels,
 *  R·G·B·A toggles (re-rendered through a canvas), and a cursor pixel readout.
 *  Pixels are decoded ONCE per image into a cached buffer; hover sampling is
 *  O(1) and channel views redraw only when a toggle flips — never on move. */
export function ImageView({
  src,
  mime,
  size,
  mtime,
  name,
  zoom,
  pan,
  pixelated,
  wrapRef,
  onPanStart,
  onDouble,
}: Props): JSX.Element {
  const [decoded, setDecoded] = useState<Decoded | null>(null);
  // natural pixel size, kept apart from `decoded` so a failed decode (huge /
  // tainted) still gets sharp zooming
  const [natural, setNatural] = useState<Box | null>(null);
  const stage = useContentBox(wrapRef);
  const [channels, setChannels] = useState<Channels>(ALL_CHANNELS);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const decodeImg = useCallback((img: HTMLImageElement) => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return;
    setNatural({ w, h });
    try {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, w, h).data;
      setDecoded({ width: w, height: h, px, alpha: hasAlpha(px) });
    } catch {
      /* decode failed (tainted / huge) — the plain <img> still shows */
    }
  }, []);

  // new image → drop the old decode, reset toggles/readout. Then decode at
  // once if the browser already has this image: reopening the SAME file feeds
  // an identical data: URL that is served from cache and complete before React
  // attaches onLoad, so onLoad never fires — and without it zoom (needs the
  // natural size) and the colour picker (needs the decoded pixels) went dead
  // on every second open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on src change
  useEffect(() => {
    setDecoded(null);
    setNatural(null);
    setChannels(ALL_CHANNELS);
    setCursor(null);
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth) decodeImg(img);
  }, [src, decodeImg]);

  const onLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => decodeImg(e.currentTarget),
    [decodeImg],
  );

  const allOn = channels.r && channels.g && channels.b && channels.a;
  // channel view: paint the filtered buffer into the visible canvas
  useEffect(() => {
    if (allOn || !decoded) return;
    const c = canvasRef.current;
    if (!c) return;
    c.width = decoded.width;
    c.height = decoded.height;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(
      new ImageData(applyChannels(decoded.px, channels), decoded.width, decoded.height),
      0,
      0,
    );
  }, [allOn, decoded, channels]);

  const onMove = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (!decoded) return;
      const p = pointerToPixel(
        e.currentTarget.getBoundingClientRect(),
        e.clientX,
        e.clientY,
        decoded.width,
        decoded.height,
      );
      setCursor((cur) => (cur && cur.x === p.x && cur.y === p.y ? cur : p));
    },
    [decoded],
  );
  const onLeave = useCallback(() => setCursor(null), []);

  const sample = useMemo(
    () =>
      decoded && cursor
        ? sampleAt(decoded.px, decoded.width, decoded.height, cursor.x, cursor.y)
        : undefined,
    [decoded, cursor],
  );
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toUpperCase() : mime;
  // Zoom is applied as a real layout size (see zoomedSize) and only the pan
  // goes through transform; until the image and stage are measured the CSS
  // max-width/height:100% fit stands in.
  const box = natural && stage ? zoomedSize(natural, stage, zoom) : null;
  const style = {
    transform: `translate(${pan.x}px, ${pan.y}px)`,
    ...(box ? { width: box.width, height: box.height, maxWidth: 'none', maxHeight: 'none' } : {}),
  };
  const cls = `fv-image${pixelated ? ' pixelated' : ''}`;

  return (
    <>
      <div
        className="fv-image-wrap"
        ref={wrapRef}
        onMouseDown={onPanStart}
        onDoubleClick={onDouble}
        style={{ cursor: zoom > 1 ? 'grab' : 'zoom-in' }}
      >
        {/* the <img> always mounts (it is the decoder); the canvas replaces it
            visually while a channel is off */}
        <img
          ref={imgRef}
          className={cls}
          src={src}
          alt={name}
          draggable={false}
          onLoad={onLoad}
          onMouseMove={onMove}
          onMouseLeave={onLeave}
          style={allOn ? style : { ...style, display: 'none' }}
        />
        {!allOn && (
          <canvas
            ref={canvasRef}
            className={cls}
            onMouseMove={onMove}
            onMouseLeave={onLeave}
            style={style}
          />
        )}
        {/* Cursor pixel readout — a HUD pinned to the stage's bottom-left,
            just above the info row. It only exists while the pointer is over
            the image, so it never permanently covers anything; pointer-events
            are off so it can't steal the very mousemove that feeds it. */}
        {cursor && sample && (
          <div className="fv-px-hud">
            <span className="fv-px-xy">
              {cursor.x}, {cursor.y}
            </span>
            <span
              className="fv-px-swatch"
              style={{
                // inset shadow paints the colour OVER the checkerboard background
                boxShadow: `inset 0 0 0 14px rgba(${sample[0]}, ${sample[1]}, ${sample[2]}, ${sample[3] / 255})`,
              }}
            />
            <span className="fv-px-hex">{hexOf(sample)}</span>
            <span className="fv-px-rgba">
              rgba({sample[0]}, {sample[1]}, {sample[2]}, {(sample[3] / 255).toFixed(2)})
            </span>
          </div>
        )}
      </div>
      <div className="fv-image-status">
        <span className="fv-image-info">
          {decoded ? `${decoded.width}×${decoded.height}` : '…'}
          {' · '}
          {ext}
          {' · '}
          {fmtBytes(size)}
          {decoded ? ` · ${decoded.alpha ? 'RGBA' : 'RGB'}` : ''}
          {mtime ? ` · ${mtime.slice(0, 16).replace('T', ' ')}` : ''}
        </span>
        <span className="fv-spacer" />
        <span className="fv-image-channels" title="Toggle channels (A off = fully opaque)">
          {(['r', 'g', 'b', 'a'] as const).map((k) => (
            <button
              type="button"
              key={k}
              className={`fv-ch fv-ch-${k}${channels[k] ? ' on' : ''}`}
              disabled={!decoded}
              onClick={() => setChannels((c) => ({ ...c, [k]: !c[k] }))}
            >
              {k.toUpperCase()}
            </button>
          ))}
        </span>
      </div>
    </>
  );
}
