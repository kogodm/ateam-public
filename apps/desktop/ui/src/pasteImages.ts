/**
 * Pictures on the clipboard of the machine the USER is sitting at.
 *
 * A screenshot pasted into a session used to go nowhere when that session was
 * reached remotely: the picture is on the clipboard of the laptop or phone in
 * front of the user, while claude — whose own Ctrl+V reads the clipboard of
 * the machine it runs on — is on the Mac. The DOM paste event is the one
 * channel that carries the local clipboard across, and it does so even on a
 * plain-http LAN page, where `navigator.clipboard` does not exist at all
 * (not a secure context). So pasted pictures are taken from the event,
 * uploaded to the Mac, and handed to the session as paths — the same shape
 * the attach button has always produced.
 */

/** The upload RPC's own ceiling (see MobileKeys / StreamView attach). */
export const PASTE_MAX_BYTES = 15 * 1024 * 1024;

/** Enough of a DataTransfer to read pictures from — lets tests pass a stub. */
export interface ClipboardLike {
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null;
  files?: ArrayLike<File> | null;
}

/** Every image file the paste carries, in order. `items` is where browsers
 *  put a screenshot; `files` is where some put a copied file — read both, and
 *  never count one picture twice. */
export function imageFilesFrom(data: ClipboardLike | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  const seen = new Set<File>();
  const take = (f: File | null): void => {
    if (!f || !f.type.startsWith('image/') || seen.has(f)) return;
    seen.add(f);
    out.push(f);
  };
  for (const it of Array.from(data.items ?? [])) {
    if (it.kind === 'file') take(it.getAsFile());
  }
  if (out.length === 0) for (const f of Array.from(data.files ?? [])) take(f);
  return out;
}

/** A name the upload can keep. A screenshot arrives as "image.png" — every
 *  one of them — so it gets a stamp; a real file name is kept as it is. */
export function pastedName(file: { name: string; type: string }, now = new Date()): string {
  const generic = !file.name || /^image\.\w+$/i.test(file.name);
  if (!generic) return file.name;
  const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `paste-${stamp}.${ext || 'png'}`;
}

/** File → base64 body for `file.upload`. */
export function fileBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
