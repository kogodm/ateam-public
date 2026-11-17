/**
 * Turning a base64 image from `file.read` into something an <img> can show.
 *
 * The obvious way — `src={`data:${mime};base64,${b64}`}` — breaks on real
 * images. A 8MB PNG is ~11MB of base64, and the desktop window is a WKWebView,
 * which does not reliably decode a data: URL that long: the top of the picture
 * comes out right and the rest degenerates into horizontal colour streaks. The
 * bytes are fine (verified identical to the file on disk) and so is the RPC —
 * only the data: URL is.
 *
 * A blob URL hands the WebView the decoded bytes instead of a giant string in
 * a DOM attribute, and has no such limit. The caller must revoke it when the
 * image goes away, or the bytes stay alive for the life of the document.
 */

/** Decode base64 to bytes without building one huge intermediate string. */
function bytesFromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return buf;
}

/** An object URL for the image. Revoke it with `URL.revokeObjectURL`. */
export function imageObjectUrl(base64: string, mime = 'image/png'): string {
  return URL.createObjectURL(new Blob([bytesFromBase64(base64)], { type: mime }));
}
