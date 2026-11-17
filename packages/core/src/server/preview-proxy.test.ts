import { createServer } from 'node:http';
import { type AddressInfo, createServer as createTcpServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type PreviewProxy, startPreviewProxy } from './preview-proxy';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

async function proxyFor(port: number): Promise<PreviewProxy> {
  const p = await startPreviewProxy({ port, host: '127.0.0.1' });
  cleanups.push(() => p.close());
  return p;
}

describe('preview proxy', () => {
  it('tells the dev server it was reached on localhost, whatever the browser sent', async () => {
    // a vite-style host check: anything but localhost/IP is "Blocked request"
    const seen: string[] = [];
    const dev = createServer((req, res) => {
      seen.push(req.headers.host ?? '');
      res.setHeader('x-echo', req.headers['x-echo'] ?? '');
      res.end(`hello ${req.url}`);
    });
    await new Promise<void>((r) => dev.listen(0, '127.0.0.1', r));
    cleanups.push(() => dev.close());
    const devPort = (dev.address() as AddressInfo).port;
    const p = await proxyFor(devPort);

    const res = await fetch(`http://127.0.0.1:${p.port}/app?x=1`, {
      headers: { host: 'relay.example.com', 'x-echo': 'kept' },
    });
    expect(await res.text()).toBe('hello /app?x=1');
    expect(seen).toEqual([`localhost:${devPort}`]);
    // other headers pass untouched
    expect(res.headers.get('x-echo')).toBe('kept');
  });

  it('answers 502 instead of hanging when the dev server is gone', async () => {
    const dead = createTcpServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const p = await proxyFor(port);
    const res = await fetch(`http://127.0.0.1:${p.port}/`);
    expect(res.status).toBe(502);
  });

  it('rewrites Host on an upgrade too and then pipes bytes raw (HMR)', async () => {
    // a bare TCP "websocket" server: captures the head, answers 101, echoes
    let head = '';
    const dev = createTcpServer((sock) => {
      sock.once('data', (buf) => {
        head = buf.toString();
        sock.write(
          'HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n',
        );
        sock.on('data', (d) => sock.write(d));
      });
    });
    await new Promise<void>((r) => dev.listen(0, '127.0.0.1', r));
    cleanups.push(() => dev.close());
    const devPort = (dev.address() as AddressInfo).port;
    const p = await proxyFor(devPort);

    const { connect } = await import('node:net');
    const client = connect(p.port, '127.0.0.1');
    cleanups.push(() => client.destroy());
    const got: string[] = [];
    client.on('data', (d) => got.push(d.toString()));
    await new Promise<void>((r) => client.once('connect', r));
    client.write(
      'GET /vite-hmr HTTP/1.1\r\nHost: relay.example.com:27444\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    await new Promise((r) => setTimeout(r, 150));
    client.write('ping-frame');
    await new Promise((r) => setTimeout(r, 150));

    expect(head).toContain(`Host: localhost:${devPort}\r\n`);
    expect(head).not.toContain('relay.example.com');
    expect(head).toContain('Sec-WebSocket-Key: abc\r\n');
    expect(got.join('')).toContain('101 Switching Protocols');
    expect(got.join('')).toContain('ping-frame');
  });
});
