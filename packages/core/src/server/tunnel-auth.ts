/**
 * The LAN server's tunnel single-sign-on token. The RelayClient mints a fresh
 * random value for every relay connection and parks it here; the LAN server
 * accepts it as a session cookie (relay clients who signed in and picked this
 * device get it from the relay), and it dies with the tunnel.
 */
let current = '';

export function setTunnelToken(token: string): void {
  current = token;
}

export function clearTunnelToken(): void {
  current = '';
}

export function verifyTunnelToken(token: string): boolean {
  return current !== '' && token === current;
}
