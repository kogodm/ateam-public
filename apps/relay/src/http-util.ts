import type { IncomingMessage, ServerResponse } from 'node:http';

export class BodyTooLarge extends Error {
  constructor() {
    super('body too large');
  }
}

export function readBodyBuffer(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((res, rej) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        rej(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}

export async function readBody(req: IncomingMessage, max: number): Promise<string> {
  return (await readBodyBuffer(req, max)).toString('utf8');
}

export function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(body);
}

export const json = (
  res: ServerResponse,
  status: number,
  obj: unknown,
  headers: Record<string, string> = {},
): void => send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), headers);
