/**
 * The waiting fox — every place in the app that makes you wait.
 *
 * Drawn as ONE outline in the same stroke family as the icons (1.8 round-capped
 * strokes, currentColor): tall pointed ears, cheeks flaring wide, then a hard
 * taper to the muzzle. That silhouette is what separates a fox from a cat at
 * 20px — a round skull and round eyes read as a cat whatever you name it — so
 * the eyes are slanted strokes, and they double as the blink.
 *
 * Motion lives in CSS (.fox-wait* in styles.css): a slow curious head-tilt and
 * a blink, both idle for most of their cycle. Wherever this mounts it is
 * usually the only thing moving on screen, so it must read as alive without
 * asking for attention. prefers-reduced-motion stops all of it.
 */
export function FoxWait({
  size = 20,
  className,
}: {
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <svg
      className={className ? `fox-wait ${className}` : 'fox-wait'}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 3 9.6 7.1h4.8L19 3c1.4 3.2 1.7 6.5 1.4 9.3-.4 4.3-4 8-8.4 9.5-4.4-1.5-8-5.2-8.4-9.5C3.3 9.5 3.6 6.2 5 3Z" />
      <path className="fox-wait-eye fox-wait-eye-l" d="m8 11.6 2.2 1.2" />
      <path className="fox-wait-eye fox-wait-eye-r" d="m16 11.6-2.2 1.2" />
      <path d="M12 18.4h.01" />
    </svg>
  );
}
