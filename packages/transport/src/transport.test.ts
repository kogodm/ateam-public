import { describe, expect, it } from 'vitest';
import { connectWs } from './ws-client';
import { createInprocPair } from './inproc';
import type { Port } from './port';
import { startWsServer } from './ws-server';

function once(port: Port): Promise<unknown> {
  return new Promise((resolve) => {
    const off = port.onMessage((m) => {
      off();
      resolve(m);
    });
  });
}

describe('inproc pair', () => {
  it('delivers messages both ways', async () => {
    const { client, server } = createInprocPair();
    const gotOnServer = once(server);
    client.send({ hello: 'server' });
    expect(await gotOnServer).toEqual({ hello: 'server' });

    const gotOnClient = once(client);
    server.send({ hello: 'client' });
    expect(await gotOnClient).toEqual({ hello: 'client' });
  });

  it('propagates close to peer', async () => {
    const { client, server } = createInprocPair();
    const closed = new Promise<void>((r) => server.onClose(() => r()));
    client.close();
    await expect(closed).resolves.toBeUndefined();
  });
});

describe('ws server + client', () => {
  it('authenticates and round-trips a message', async () => {
    const handle = await startWsServer(
      (port) => {
        port.onMessage((m) => port.send({ echo: m }));
      },
      { writeHandshakeFile: false },
    );

    const client = await connectWs({ port: handle.port, token: handle.token });
    const reply = once(client);
    client.send({ ping: 1 });
    expect(await reply).toEqual({ echo: { ping: 1 } });

    client.close();
    await handle.close();
  });

  it('rejects a bad token', async () => {
    const handle = await startWsServer(() => {}, { writeHandshakeFile: false });
    await expect(connectWs({ port: handle.port, token: 'wrong' })).rejects.toBeDefined();
    await handle.close();
  });
});
