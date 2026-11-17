import { useEffect, useRef, useState } from 'react';
import { localImageSources, withInlinedImages } from './htmlAssets';
import {
  type HtmlVideoAsset,
  prepareHtmlVideos,
  streamHtmlVideos,
  videoTimeout,
} from './htmlVideo';
import type { Rpc } from './rpc';

export function HtmlPreview({
  rpc,
  html,
  path,
  title,
}: {
  rpc: Rpc;
  html: string;
  path: string;
  title: string;
}): JSX.Element {
  const [page, setPage] = useState<{ html: string; assets: HtmlVideoAsset[] } | null>(null);
  const [error, setError] = useState('');
  const stop = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    stop.current();
    setPage(null);
    setError('');
    const urls = new Map<string, string>();
    const jobs = [...localImageSources(html, path)];
    const next = async (): Promise<void> => {
      for (let job = jobs.shift(); job && alive; job = jobs.shift()) {
        const [src, local] = job;
        const image = await videoTimeout(
          rpc
            .request('file.thumb', { path: local, max: 1600 })
            .catch(() => rpc.request('file.read', { path: local })),
        ).catch(() => null);
        if (image?.kind === 'image' && image.base64)
          urls.set(src, `data:${image.mime};base64,${image.base64}`);
      }
    };
    void Promise.all(Array.from({ length: 4 }, next))
      .then(() => {
        if (alive) setPage(prepareHtmlVideos(withInlinedImages(html, urls), path));
      })
      .catch((error: unknown) => {
        if (alive) setError(error instanceof Error ? error.message : 'HTML preview failed');
      });
    return () => {
      alive = false;
      stop.current();
    };
  }, [rpc, html, path]);

  const load = (frame: HTMLIFrameElement): void => {
    stop.current();
    if (!page?.assets.length || !frame.contentWindow) return;
    const controller = new AbortController();
    const channel = new MessageChannel();
    let sequence = 0;
    let pending: { seq: number; resolve: () => void; reject: (error: Error) => void } | undefined;
    const ready = new Promise<void>((resolve) => {
      channel.port1.onmessage = (event: MessageEvent) => {
        if (event.data?.type === 'ready') resolve();
        if (event.data?.type === 'ack' && event.data.seq === pending?.seq) {
          pending?.resolve();
          pending = undefined;
        }
      };
    });
    stop.current = () => {
      controller.abort();
      pending?.reject(new Error('Preview closed'));
      pending = undefined;
      channel.port1.postMessage({ type: 'dispose' });
      channel.port1.close();
    };
    const send = (
      message: Record<string, unknown>,
      transfer: Transferable[] = [],
    ): Promise<void> => {
      if (controller.signal.aborted) return Promise.reject(new Error('Preview closed'));
      const seq = sequence++;
      return videoTimeout(
        new Promise<void>((resolve, reject) => {
          pending = { seq, resolve, reject };
          channel.port1.postMessage({ ...message, seq }, transfer);
        }),
      );
    };
    frame.contentWindow.postMessage({ type: 'ateam-video-connect' }, '*', [channel.port2]);
    void videoTimeout(ready)
      .then(() => {
        if (!controller.signal.aborted)
          return streamHtmlVideos(rpc, page.assets, send, controller.signal);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setError(error instanceof Error ? error.message : 'Local video loading failed');
          stop.current();
        }
      });
  };

  return (
    <>
      {error && (
        <div role="alert" className="muted small">
          Local video preview: {error}
        </div>
      )}
      {page ? (
        <iframe
          className="fv-html"
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={page.html}
          onLoad={(event) => load(event.currentTarget)}
        />
      ) : (
        <output className="muted small">Loading HTML assets…</output>
      )}
    </>
  );
}
