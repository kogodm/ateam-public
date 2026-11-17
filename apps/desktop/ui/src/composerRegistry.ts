/**
 * Every stream view's composer, addressable by sessionId.
 *
 * Filling a session's input has one destination in terminal mode — the PTY,
 * via session.input — and a different one in stream mode, where the composer
 * is a React textarea that the PTY knows nothing about. Writing to the PTY
 * from stream mode is not an error; it is worse. The text lands in the hidden
 * terminal, the visible box stays empty, and the next thing the user does in
 * the terminal has a stray task pasted in front of it.
 *
 * So the stream registers its setter here and the filler asks for it first,
 * falling back to the PTY when the session is not being read as a stream.
 */
type Fill = (text: string) => void;
/** files dropped on the window: pictures become attachment cards, anything
 *  else its path in the box — the PTY's insert would land out of sight */
type Drop = (paths: string[]) => void;

const composers = new Map<string, { fill: Fill; drop?: Drop }>();

export function registerComposer(sessionId: string, fill: Fill, drop?: Drop): void {
  composers.set(sessionId, { fill, drop });
}

export function unregisterComposer(sessionId: string): void {
  composers.delete(sessionId);
}

/** true when a stream composer took the text. */
export function fillComposer(sessionId: string, text: string): boolean {
  const c = composers.get(sessionId);
  if (!c) return false;
  c.fill(text);
  return true;
}

/** true when a stream composer took the dropped paths. */
export function dropOnComposer(sessionId: string, paths: string[]): boolean {
  const c = composers.get(sessionId);
  if (!c?.drop || paths.length === 0) return false;
  c.drop(paths);
  return true;
}
