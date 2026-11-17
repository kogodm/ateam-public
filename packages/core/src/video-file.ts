import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import type { VideoChunkDTO } from '@ateam/contract';
import { resolveHome } from './fsview';

export const VIDEO_MAX_BYTES = 128 * 1024 * 1024;
export const VIDEO_CHUNK_BYTES = 256 * 1024;
const MIME: Record<string, VideoChunkDTO['mime']> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

export async function readVideoChunk(params: {
  path: string;
  offset: number;
  length: number;
  version?: string;
}): Promise<VideoChunkDTO> {
  const mime = MIME[extname(params.path).toLowerCase()];
  if (!mime) throw new Error('Video format not supported: use MP4, WebM or MOV');
  if (
    !Number.isSafeInteger(params.offset) ||
    params.offset < 0 ||
    !Number.isSafeInteger(params.length) ||
    params.length < 1 ||
    params.length > VIDEO_CHUNK_BYTES
  ) {
    throw new Error('Invalid video chunk range (maximum 256 KiB)');
  }
  const handle = await open(resolveHome(params.path), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Video must be a regular file');
    if (!stat.size || stat.size > VIDEO_MAX_BYTES)
      throw new Error('Video must be between 1 byte and 128 MiB');
    const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if ((params.offset > 0 && !params.version) || (params.version && params.version !== version)) {
      throw new Error('Video changed while loading; reopen the preview');
    }
    if (params.offset >= stat.size) throw new Error('Video offset is past the end');
    const header = Buffer.alloc(12);
    const head = await handle.read(header, 0, header.length, 0);
    const valid =
      mime === 'video/webm'
        ? header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
        : head.bytesRead >= 8 &&
          (mime === 'video/mp4'
            ? header.toString('ascii', 4, 8) === 'ftyp'
            : ['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(header.toString('ascii', 4, 8)));
    if (!valid) throw new Error('Video container does not match its file extension');
    const bytes = Buffer.alloc(Math.min(params.length, stat.size - params.offset));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, params.offset);
    const after = await handle.stat();
    if (
      bytesRead !== bytes.length ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw new Error('Video changed while loading; reopen the preview');
    }
    return {
      mime,
      size: stat.size,
      offset: params.offset,
      version,
      base64: bytes.toString('base64'),
    };
  } finally {
    await handle.close();
  }
}
