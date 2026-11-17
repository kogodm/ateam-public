import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { json } from './http-util';

/**
 * The desktop app's update feed: a plain file tree the Tauri updater reads.
 *
 * `GET /update/latest.json` is the manifest, `GET /update/v<ver>/<file>` the
 * signed bundles it points at. Which version is newer is the updater's call,
 * not ours — this is a static site with one writer.
 *
 * The writer is CI: `PUT /update/<path>` with the publish token. Why push from
 * CI instead of the relay pulling from GitHub: this machine sits in mainland
 * China, where GitHub downloads stall (get.acme.sh already did). The token is
 * kept only as its sha256, like device tokens.
 *
 * The bundles carry their own minisign signature checked by the app against
 * the public key it was built with — a leaked publish token can deny updates,
 * it cannot ship code.
 */
export interface UpdateApiDeps {
  /** root of the file tree */
  dir: string;
  /** sha256 hex of the publish token; absent = publishing is off */
  tokenSha256?: string;
  rateLimited(ip: string): boolean;
  noteFailure(ip: string): void;
}

/** a bundle is ~100MB; this is a ceiling against a runaway upload, not a quota */
const MAX_UPLOAD = 800 * 1024 * 1024;
/** one path segment: no leading dot (so no `..`, no hidden files), no escapes */
const PATH_RE = /^\/update\/([A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*)$/;

export async function handleUpdateApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: UpdateApiDeps,
): Promise<void> {
  try {
    const rel = PATH_RE.exec((req.url ?? '').split('?')[0] ?? '')?.[1];
    if (!rel) return json(res, 400, { err: 'bad path' });
    const file = join(deps.dir, rel);
    if (req.method === 'GET' || req.method === 'HEAD') return await serve(req, res, file, rel);
    if (req.method === 'PUT') return await publish(req, res, file, deps);
    json(res, 405, { err: 'method not allowed' });
  } catch (e) {
    if (res.headersSent) return void res.destroy();
    json(res, 500, { err: e instanceof Error ? e.message : String(e) });
  }
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  rel: string,
): Promise<void> {
  const st = await stat(file).catch(() => undefined);
  if (!st?.isFile()) return json(res, 404, { err: 'not found' });
  const manifest = rel.endsWith('.json');
  res.writeHead(200, {
    'content-type': manifest ? 'application/json; charset=utf-8' : 'application/octet-stream',
    'content-length': String(st.size),
    // the manifest moves; a versioned bundle never changes once published
    'cache-control': manifest ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') return void res.end();
  await pipeline(createReadStream(file), res);
}

function authorized(req: IncomingMessage, tokenSha256: string): boolean {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  if (!m?.[1]) return false;
  const got = createHash('sha256').update(m[1]).digest();
  const want = Buffer.from(tokenSha256, 'hex');
  return want.length === got.length && timingSafeEqual(got, want);
}

async function publish(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  deps: UpdateApiDeps,
): Promise<void> {
  if (!deps.tokenSha256) return json(res, 403, { err: 'publishing is off' });
  const ip = req.socket.remoteAddress ?? '?';
  if (deps.rateLimited(ip)) return json(res, 429, { err: 'locked' });
  if (!authorized(req, deps.tokenSha256)) {
    deps.noteFailure(ip);
    return json(res, 401, { err: 'bad token' });
  }
  if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD)
    return json(res, 413, { err: 'too large' });
  await mkdir(dirname(file), { recursive: true });
  // written aside and renamed in: a reader never sees half a bundle, and a
  // failed upload leaves the previous file standing
  const part = `${file}.part-${randomBytes(4).toString('hex')}`;
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_UPLOAD) req.destroy(new Error('too large'));
  });
  try {
    await pipeline(req, createWriteStream(part));
    await rename(part, file);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
  json(res, 201, { ok: true, bytes: size });
}
