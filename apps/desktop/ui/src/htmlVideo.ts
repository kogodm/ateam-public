import { toLocalPath } from './htmlAssets';
import type { Rpc } from './rpc';

export const VIDEO_CHUNK_BYTES = 256 * 1024;
export const VIDEO_MAX_BYTES = 128 * 1024 * 1024;
export const VIDEO_PREVIEW_BYTES = 256 * 1024 * 1024;
export type HtmlVideoAsset = { id: string; path: string };

export function prepareHtmlVideos(
  html: string,
  path: string,
): { html: string; assets: HtmlVideoAsset[] } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const dir = path.slice(0, path.lastIndexOf('/'));
  const assets: HtmlVideoAsset[] = [];
  const byPath = new Map<string, string>();
  for (const node of doc.querySelectorAll('video[src], video source[src]')) {
    const local = toLocalPath(node.getAttribute('src') ?? '', dir);
    if (!local) continue;
    let id = byPath.get(local);
    if (!id) {
      id = String(assets.length);
      byPath.set(local, id);
      assets.push({ id, path: local });
    }
    node.setAttribute('data-ateam-video', id);
    node.removeAttribute('src');
  }
  if (!assets.length) return { html, assets };
  for (const anchor of doc.querySelectorAll('a[href]')) {
    const local = toLocalPath(anchor.getAttribute('href') ?? '', dir);
    const id = local && byPath.get(local);
    if (id) {
      anchor.setAttribute('data-ateam-video-link', id);
      anchor.removeAttribute('href');
    }
  }
  const script = doc.createElement('script');
  script.textContent = `(${videoSandbox.toString()})();`;
  doc.body.append(script);
  return { html: `<!doctype html>${doc.documentElement.outerHTML}`, assets };
}

export async function streamHtmlVideos(
  rpc: Rpc,
  assets: HtmlVideoAsset[],
  send: (message: Record<string, unknown>, transfer?: Transferable[]) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let reserved = 0;
  for (const asset of assets) {
    if (signal.aborted) return;
    let offset = 0;
    let version: string | undefined;
    let size = 0;
    let mime = '';
    try {
      do {
        const chunk = await videoTimeout(
          rpc.request('file.videoChunk', {
            path: asset.path,
            offset,
            length: VIDEO_CHUNK_BYTES,
            version,
          }),
        );
        if (signal.aborted) return;
        if (offset === 0) {
          if (
            !Number.isSafeInteger(chunk.size) ||
            chunk.size < 1 ||
            chunk.size > VIDEO_MAX_BYTES ||
            !['video/mp4', 'video/webm', 'video/quicktime'].includes(chunk.mime)
          ) {
            throw new Error('Invalid video size or MIME (maximum 128 MiB)');
          }
          if (reserved + chunk.size > VIDEO_PREVIEW_BYTES)
            throw new Error('Preview videos exceed 256 MiB total');
          reserved += chunk.size;
          size = chunk.size;
          mime = chunk.mime;
          version = chunk.version;
        }
        if (
          chunk.size !== size ||
          chunk.mime !== mime ||
          chunk.version !== version ||
          chunk.offset !== offset
        ) {
          throw new Error('Video changed while loading');
        }
        const raw = atob(chunk.base64);
        if (!raw.length || raw.length > VIDEO_CHUNK_BYTES || offset + raw.length > size) {
          throw new Error('Invalid video chunk');
        }
        const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
        offset += bytes.length;
        await send({ type: 'chunk', id: asset.id, bytes: bytes.buffer, mime, size, offset }, [
          bytes.buffer,
        ]);
        if (signal.aborted) return;
      } while (offset < size);
      await send({ type: 'done', id: asset.id, mime });
    } catch (error) {
      if (signal.aborted) return;
      await send({
        type: 'error',
        id: asset.id,
        message: error instanceof Error ? error.message : 'Video load failed',
      });
    }
  }
}

export function videoTimeout<T>(promise: Promise<T>, ms = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Video loading timed out; reopen the preview')),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function videoSandbox(): void {
  const chunks = new Map<string, ArrayBuffer[]>();
  const urls = new Map<string, string>();
  const statuses = new Map<HTMLVideoElement, HTMLElement>();
  const timers = new Map<HTMLVideoElement, ReturnType<typeof setTimeout>>();
  const players = (id: string): HTMLVideoElement[] =>
    [...document.querySelectorAll<HTMLElement>('[data-ateam-video]')]
      .filter((node) => node.dataset.ateamVideo === id)
      .map((node) => (node.tagName === 'VIDEO' ? node : node.closest('video')) as HTMLVideoElement)
      .filter((node, index, list) => node && list.indexOf(node) === index);
  for (const video of document.querySelectorAll<HTMLVideoElement>('video')) {
    if (!video.matches('[data-ateam-video]') && !video.querySelector('[data-ateam-video]'))
      continue;
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    status.style.cssText =
      'font:13px system-ui;padding:6px;color:#fff;background:#222;white-space:pre-wrap';
    status.textContent = 'Loading local video…';
    video.after(status);
    statuses.set(video, status);
    video.addEventListener('loadedmetadata', () => {
      clearTimeout(timers.get(video));
      status.textContent = '';
    });
    video.addEventListener('error', () => {
      if (
        video.matches('[data-ateam-video]:not([data-ateam-ready])') ||
        video.querySelector('[data-ateam-video]:not([data-ateam-ready])')
      )
        return;
      status.textContent =
        'Video playback failed: this browser may not support the codec. Try opening the original in an external player.';
    });
  }
  const dispose = (): void => {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    for (const timer of timers.values()) clearTimeout(timer);
    urls.clear();
    chunks.clear();
  };
  window.addEventListener('pagehide', dispose);
  window.addEventListener('message', function connect(event: MessageEvent) {
    if (event.source !== parent || event.data?.type !== 'ateam-video-connect' || !event.ports[0])
      return;
    window.removeEventListener('message', connect);
    const port = event.ports[0];
    port.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'dispose') {
        dispose();
        port.close();
        return;
      }
      const affected = players(msg.id);
      if (msg.type === 'chunk') {
        const parts = chunks.get(msg.id) ?? [];
        parts.push(msg.bytes);
        chunks.set(msg.id, parts);
        for (const video of affected) {
          const status = statuses.get(video);
          if (status)
            status.textContent = `Loading local video… ${Math.floor((msg.offset / msg.size) * 100)}%`;
        }
      } else if (msg.type === 'done') {
        const parts = chunks.get(msg.id) ?? [];
        const url = URL.createObjectURL(new Blob(parts, { type: msg.mime || 'video/mp4' }));
        urls.set(msg.id, url);
        chunks.delete(msg.id);
        for (const node of document.querySelectorAll<HTMLElement>('[data-ateam-video]')) {
          if (node.dataset.ateamVideo !== msg.id) continue;
          node.setAttribute('src', url);
          node.setAttribute('data-ateam-ready', 'true');
        }
        for (const node of document.querySelectorAll<HTMLAnchorElement>(
          '[data-ateam-video-link]',
        )) {
          if (node.dataset.ateamVideoLink === msg.id) node.href = url;
        }
        for (const video of affected) {
          video.load();
          clearTimeout(timers.get(video));
          timers.set(
            video,
            setTimeout(() => {
              const status = statuses.get(video);
              if (status && video.readyState === 0)
                status.textContent = 'Video format/codec could not be loaded by this browser.';
            }, 30_000),
          );
        }
      } else if (msg.type === 'error') {
        chunks.delete(msg.id);
        for (const node of document.querySelectorAll<HTMLElement>('[data-ateam-video]')) {
          if (node.dataset.ateamVideo === msg.id) node.setAttribute('data-ateam-ready', 'failed');
        }
        for (const video of affected) {
          const status = statuses.get(video);
          if (status) status.textContent = `Local video load failed: ${msg.message}`;
        }
      }
      port.postMessage({ type: 'ack', seq: msg.seq });
    };
    port.postMessage({ type: 'ready' });
  });
}
