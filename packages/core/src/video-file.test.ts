import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateParams } from '@ateam/contract';
import type { VideoChunkDTO } from '@ateam/contract';
import type { LlmSynthesizer } from '@ateam/knowledge';
import { createInprocPair } from '@ateam/transport';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RpcClient } from './server/rpc-client';
import { createServer } from './server/rpc-server';
import { SessionManager } from './session/manager';
import { VIDEO_CHUNK_BYTES, VIDEO_MAX_BYTES, readVideoChunk } from './video-file';

describe('authenticated video chunks', () => {
  let dir: string;
  let path: string;
  const bytes = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from('ftypisom'),
    Buffer.alloc(VIDEO_CHUNK_BYTES + 17, 42),
  ]);
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ateam-video-'));
    path = join(dir, 'clip.mp4');
    await writeFile(path, bytes);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it('reconstructs bytes with bounded chunks and consistent metadata', async () => {
    const first = await readVideoChunk({ path, offset: 0, length: VIDEO_CHUNK_BYTES });
    const last = await readVideoChunk({
      path,
      offset: VIDEO_CHUNK_BYTES,
      length: VIDEO_CHUNK_BYTES,
      version: first.version,
    });
    expect(first.mime).toBe('video/mp4');
    expect(first.size).toBe(bytes.length);
    expect(
      Buffer.concat([Buffer.from(first.base64, 'base64'), Buffer.from(last.base64, 'base64')]),
    ).toEqual(bytes);
    expect(last.offset).toBe(VIDEO_CHUNK_BYTES);
    expect(last.version).toBe(first.version);
  });
  it('accepts WebM and MOV containers', async () => {
    const webm = join(dir, 'clip.webm');
    const mov = join(dir, 'clip.mov');
    await writeFile(webm, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]));
    await writeFile(mov, Buffer.from([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76]));
    expect((await readVideoChunk({ path: webm, offset: 0, length: 12 })).mime).toBe('video/webm');
    expect((await readVideoChunk({ path: mov, offset: 0, length: 12 })).mime).toBe(
      'video/quicktime',
    );
  });
  it('rejects missing, empty, oversized, unsupported and disguised files', async () => {
    await expect(
      readVideoChunk({ path: join(dir, 'missing.mp4'), offset: 0, length: 12 }),
    ).rejects.toThrow();
    await expect(
      readVideoChunk({ path: join(dir, 'image.png'), offset: 0, length: 12 }),
    ).rejects.toThrow('format');
    await writeFile(path, 'not a movie');
    await expect(readVideoChunk({ path, offset: 0, length: 12 })).rejects.toThrow('container');
    await truncate(path, 0);
    await expect(readVideoChunk({ path, offset: 0, length: 12 })).rejects.toThrow('128 MiB');
    await truncate(path, VIDEO_MAX_BYTES + 1);
    await expect(readVideoChunk({ path, offset: 0, length: 12 })).rejects.toThrow('128 MiB');
    const folder = join(dir, 'directory.mp4');
    await mkdir(folder);
    await expect(readVideoChunk({ path: folder, offset: 0, length: 12 })).rejects.toThrow(
      'regular file',
    );
  });
  it('rejects changed files, missing version and out-of-range reads', async () => {
    const first = await readVideoChunk({ path, offset: 0, length: 12 });
    await expect(readVideoChunk({ path, offset: 12, length: 12 })).rejects.toThrow('changed');
    await expect(
      readVideoChunk({ path, offset: bytes.length, length: 12, version: first.version }),
    ).rejects.toThrow('end');
    await writeFile(path, Buffer.concat([bytes, Buffer.from('changed')]));
    await expect(
      readVideoChunk({ path, offset: 12, length: 12, version: first.version }),
    ).rejects.toThrow('changed');
    await expect(readVideoChunk({ path, offset: -1, length: 12 })).rejects.toThrow('range');
    await expect(
      readVideoChunk({ path, offset: 0, length: VIDEO_CHUNK_BYTES + 1 }),
    ).rejects.toThrow('range');
  });
  it('validates RPC schema boundaries', () => {
    expect(() =>
      validateParams('file.videoChunk', { path, offset: 0, length: VIDEO_CHUNK_BYTES }),
    ).not.toThrow();
    for (const params of [
      { path, offset: -1, length: 1 },
      { path, offset: 0.5, length: 1 },
      { path, offset: 0, length: VIDEO_CHUNK_BYTES + 1 },
      { path, offset: 0, length: 0 },
      { path: '', offset: 0, length: 1 },
    ])
      expect(() => validateParams('file.videoChunk', params)).toThrow();
  });
  it('exposes bounded video chunks through the actual RPC dispatcher', async () => {
    const previousHome = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = dir;
    const synth: LlmSynthesizer = {
      async reflect() {
        return [];
      },
      async learnFromRepo() {
        return [];
      },
      async distillSkill(domain) {
        return { name: domain, domain, description: '', body: '', tags: [] };
      },
    };
    const server = createServer({ sessions: new SessionManager(), synth, storeRoot: dir });
    try {
      const pair = createInprocPair();
      server.attach(pair.server);
      const client = new RpcClient(pair.client);
      const chunk = await client.request<VideoChunkDTO>('file.videoChunk', {
        path,
        offset: 0,
        length: 12,
      });
      expect(Buffer.from(chunk.base64, 'base64')).toEqual(bytes.subarray(0, 12));
      await expect(
        client.request('file.videoChunk', { path, offset: 0, length: VIDEO_CHUNK_BYTES + 1 }),
      ).rejects.toThrow();
      pair.client.close();
    } finally {
      server.shutdown();
      if (previousHome === undefined) Reflect.deleteProperty(process.env, 'ATEAM_HOME');
      else process.env.ATEAM_HOME = previousHome;
    }
  });
});
