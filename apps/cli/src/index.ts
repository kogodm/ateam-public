#!/usr/bin/env tsx
/**
 * `ateam serve` — host the core over a loopback WebSocket so a remote client
 * (and, later, the Tauri shell) can drive the same backend the embedded TUI
 * uses. Writes a handshake file for clients to discover the port + token.
 */
import { SessionManager, createServer } from '@ateam/core';
import { startWsServer } from '@ateam/transport';
import { Command } from 'commander';

const program = new Command();
program.name('ateam').description('Ateam multi-agent session host');

program
  .command('serve')
  .description('host the core over a loopback WebSocket')
  .action(async () => {
    const sessions = new SessionManager();
    const server = createServer({ sessions });
    const handle = await startWsServer((port) => server.attach(port));
    process.stdout.write(
      `Ateam serving on ws://127.0.0.1:${handle.port}  (token written to handshake file)\n` +
        'Press Ctrl-C to stop.\n',
    );
    const stop = async (): Promise<void> => {
      server.shutdown();
      await handle.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
  });

program.parseAsync(process.argv);
