import { request as httpsRequest } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { fingerprintProblem, normalizeFingerprint } from './fingerprint';

/**
 * Desktop-side self-registration against a relay (POST /relay/api/register-
 * device with account credentials). With `tlsFingerprint` set the relay's
 * self-signed cert is pinned: verified on secureConnect, and the BODY (the
 * credentials) is only written after the pin matches — headers carry nothing
 * secret, so an impostor relay learns nothing.
 */
export function registerWithRelay(args: {
  baseUrl: string;
  email: string;
  password: string;
  name: string;
  tlsFingerprint?: string;
  /** reuse this machine's device on the relay instead of adding one */
  installationId?: string;
  /** needed only when this email has no account yet (relay signup mode 'invite') */
  invite?: string;
}): Promise<{
  deviceId: string;
  token: string;
  agentUrl: string;
  accountId: string;
  email: string;
}> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(args.baseUrl);
    } catch {
      reject(new Error('relay URL must look like https://host:27443'));
      return;
    }
    if (u.protocol !== 'https:') {
      reject(new Error('relay URL must be https://'));
      return;
    }
    const fp = normalizeFingerprint(args.tlsFingerprint ?? '');
    // catch a bad paste HERE: carried into the TLS handshake it comes back as
    // "certificate mismatch", which sends the user hunting the relay's cert
    // when the problem is the string in the box
    if (fp) {
      const bad = fingerprintProblem(fp);
      if (bad) {
        reject(new Error(`that fingerprint doesn't look right — ${bad}`));
        return;
      }
    }
    const body = JSON.stringify({
      email: args.email,
      password: args.password,
      name: args.name,
      ...(args.installationId ? { installationId: args.installationId } : {}),
      ...(args.invite?.trim() ? { invite: args.invite.trim() } : {}),
    });
    const req = httpsRequest(
      {
        host: u.hostname,
        port: u.port || 443,
        method: 'POST',
        path: '/relay/api/register-device',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: 12_000,
        // fresh socket every time: the body is written from secureConnect,
        // which never fires on a pooled, already-established connection
        agent: false,
        ...(fp ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => {
          data += c.toString('utf8');
          if (data.length > 64 * 1024) req.destroy(new Error('response too large'));
        });
        res.on('end', () => {
          try {
            const o = JSON.parse(data) as {
              deviceId?: string;
              token?: string;
              agentPort?: number;
              accountId?: string;
              email?: string;
              err?: string;
            };
            if (res.statusCode !== 200 || !o.deviceId || !o.token || !o.agentPort) {
              reject(new Error(o.err ?? `relay answered ${res.statusCode}`));
              return;
            }
            resolve({
              deviceId: o.deviceId,
              token: o.token,
              agentUrl: `wss://${u.hostname}:${o.agentPort}`,
              // a relay from before sync sends neither
              accountId: o.accountId ?? '',
              email: o.email ?? args.email.trim().toLowerCase(),
            });
          } catch {
            reject(new Error('relay answered with something that is not JSON — wrong URL?'));
          }
        });
      },
    );
    req.on('socket', (sock) => {
      sock.on('secureConnect', () => {
        if (!fp) {
          req.end(body);
          return;
        }
        const got = ((sock as TLSSocket).getPeerCertificate()?.fingerprint256 ?? '')
          .replace(/:/g, '')
          .toUpperCase();
        if (got !== fp) {
          // Print BOTH fingerprints in full. The presented one is the only
          // thing the user needs to fix this, and truncating it to 16 chars
          // meant the message named the answer without giving it — the value
          // had to be fetched from the relay box anyway. ssh does the same on
          // a host-key mismatch; the value is only trustworthy once it is
          // checked out-of-band, which the hint says.
          req.destroy(
            new Error(
              `relay certificate fingerprint mismatch — ${u.hostname}:${u.port || 443} presented ${got}, you entered ${fp || '(nothing)'}. Run \`fingerprint\` on the relay box and paste what it prints; only trust the value above if the two match.`,
            ),
          );
          return;
        }
        req.end(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('relay did not answer in time')));
    req.on('error', (e) => reject(e));
    if (!fp) {
      /* body sent from secureConnect for pinned; for system-CA the handler
         above also ends the request — nothing else to do */
    }
  });
}
