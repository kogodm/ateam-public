import type { VideoChunkDTO } from '@ateam/contract';
import { describe, expect, it, vi } from 'vitest';
import { VIDEO_CHUNK_BYTES, VIDEO_MAX_BYTES, streamHtmlVideos, videoTimeout } from './htmlVideo';
import type { Rpc } from './rpc';

const asset = { id: '0', path: '/report/clip.mp4' };
const makeChunk = (overrides: Partial<VideoChunkDTO> = {}): VideoChunkDTO => ({
  size: 4,
  offset: 0,
  mime: 'video/mp4',
  version: 'v1',
  base64: btoa('film'),
  ...overrides,
});
const rpcFor = (request: ReturnType<typeof vi.fn>): Rpc =>
  ({ request, on: vi.fn(), onClose: vi.fn() }) as Rpc;

describe('HTML video transport', () => {
  it('uses only video RPC, bounded sequential chunks and transferred buffers', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        makeChunk({ size: VIDEO_CHUNK_BYTES + 4, base64: btoa('a'.repeat(VIDEO_CHUNK_BYTES)) }),
      )
      .mockResolvedValueOnce(makeChunk({ size: VIDEO_CHUNK_BYTES + 4, offset: VIDEO_CHUNK_BYTES }));
    const send = vi.fn().mockResolvedValue(undefined);
    await streamHtmlVideos(rpcFor(request), [asset], send, new AbortController().signal);
    expect(request.mock.calls).toEqual([
      [
        'file.videoChunk',
        { path: asset.path, offset: 0, length: VIDEO_CHUNK_BYTES, version: undefined },
      ],
      [
        'file.videoChunk',
        { path: asset.path, offset: VIDEO_CHUNK_BYTES, length: VIDEO_CHUNK_BYTES, version: 'v1' },
      ],
    ]);
    expect(send.mock.calls[0]?.[1]?.[0]).toBe(send.mock.calls[0]?.[0]?.bytes);
    expect(send.mock.calls[2]?.[0]).toEqual({ type: 'done', id: '0', mime: 'video/mp4' });
  });
  it('reports RPC failures and continues to the next asset', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('file not found'))
      .mockResolvedValueOnce(makeChunk());
    const send = vi.fn().mockResolvedValue(undefined);
    await streamHtmlVideos(
      rpcFor(request),
      [asset, { ...asset, id: '1' }],
      send,
      new AbortController().signal,
    );
    expect(send.mock.calls[0]?.[0]).toEqual({ type: 'error', id: '0', message: 'file not found' });
    expect(send.mock.calls.at(-1)?.[0]?.type).toBe('done');
  });
  it('enforces per-video size, MIME and chunk integrity', async () => {
    for (const overrides of [
      { size: VIDEO_MAX_BYTES + 1 },
      { mime: 'image/png' as VideoChunkDTO['mime'] },
      { offset: 1 },
      { base64: '' },
      { base64: btoa('too long') },
    ]) {
      const send = vi.fn().mockResolvedValue(undefined);
      await streamHtmlVideos(
        rpcFor(vi.fn().mockResolvedValue(makeChunk(overrides))),
        [asset],
        send,
        new AbortController().signal,
      );
      expect(send.mock.calls[0]?.[0]?.type).toBe('error');
    }
  });
  it('reserves at most 256 MiB for the entire page, including failed partial loads', async () => {
    const request = vi.fn().mockResolvedValue(makeChunk({ size: VIDEO_MAX_BYTES }));
    const send = vi.fn().mockResolvedValue(undefined);
    await streamHtmlVideos(
      rpcFor(request),
      [asset, { ...asset, id: '1' }, { ...asset, id: '2' }],
      send,
      new AbortController().signal,
    );
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'error',
      id: '2',
      message: 'Preview videos exceed 256 MiB total',
    });
    expect(request).toHaveBeenCalledTimes(5);
  });
  it('stops stale RPC results and does not start another read before chunk acknowledgement', async () => {
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValue(makeChunk());
    const send = vi.fn(async () => {
      controller.abort();
    });
    await streamHtmlVideos(
      rpcFor(request),
      [asset, { ...asset, id: '1' }],
      send,
      controller.signal,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const cancelledSend = vi.fn();
    const active = new AbortController();
    const late = vi.fn(async () => {
      active.abort();
      return makeChunk();
    });
    await streamHtmlVideos(rpcFor(late), [asset], cancelledSend, active.signal);
    expect(cancelledSend).not.toHaveBeenCalled();
  });
  it('times out rather than silently waiting forever', async () => {
    await expect(videoTimeout(new Promise(() => {}), 1)).rejects.toThrow('timed out');
  });
  it('waits for iframe acknowledgement before reading another chunk', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(makeChunk({ size: 8 }))
      .mockResolvedValueOnce(makeChunk({ size: 8, offset: 4 }));
    let acknowledge: (() => void) | undefined;
    const send = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            acknowledge = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const task = streamHtmlVideos(rpcFor(request), [asset], send, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledTimes(1);
    acknowledge?.();
    await task;
    expect(request).toHaveBeenCalledTimes(2);
  });
});
