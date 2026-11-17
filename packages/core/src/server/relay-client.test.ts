import { describe, expect, it } from 'vitest';
import { DEAD_MS, PING_MS, RELAY_CLOSE, closeAction, previewDial } from './relay-client';

describe('relay tunnel watchdog', () => {
  it('waits out more than two ping intervals before declaring the tunnel dead', () => {
    // one dropped ping must never trigger a reconnect — that would turn a
    // blip into a reconnect storm, and every reconnect re-auths the device
    expect(DEAD_MS).toBeGreaterThan(PING_MS * 2);
  });

  it('still notices within a minute, not a lifetime', () => {
    // the failure it exists for (network change kills TCP with no FIN) is
    // invisible until the watchdog fires: the user must not wait long
    expect(DEAD_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('what a relay hang-up means', () => {
  it("stands down when another process took this machine's slot", () => {
    // reconnecting would take the slot back and the two would trade the
    // tunnel twice a second — the phone then lands on a different tunnel
    // per request and remote access is unusable
    expect(closeAction(RELAY_CLOSE.replaced)).toBe('stand-down');
  });

  it('backs off, but keeps trying, when the relay parks it', () => {
    // the park is a cooldown, not a verdict
    expect(closeAction(RELAY_CLOSE.parked)).toBe('slow-retry');
  });

  it('retries an ordinary close — a blip is not a verdict either', () => {
    expect(closeAction(1006)).toBe('retry');
    expect(closeAction(1000)).toBe('retry');
  });
});

describe('where a channel gets dialled', () => {
  const LAN = 4380;
  const approved = new Map([[5199, '::1']]);

  it('sends an ordinary channel to the LAN server, as it always did', () => {
    expect(previewDial({ framePort: undefined, lanPort: LAN, approved })).toEqual({ kind: 'lan' });
  });

  it('sends an approved port through to preview (its proxy fronts the host)', () => {
    // the host lives on the proxy now (relay-client rebuilds it if the dev
    // server moves 127.0.0.1 ↔ ::1); the dial only needs the port
    expect(previewDial({ framePort: 5199, lanPort: LAN, approved })).toEqual({
      kind: 'preview',
      port: 5199,
    });
  });

  it('REFUSES a port nobody approved — the relay may ask, never name a target', () => {
    // the shape of a hand-edited cookie reaching for the database
    expect(previewDial({ framePort: 5432, lanPort: LAN, approved })).toEqual({ kind: 'refuse' });
    expect(previewDial({ framePort: 5199, lanPort: LAN, approved: new Map() })).toEqual({
      kind: 'refuse',
    });
  });

  it('treats the LAN port itself as the LAN, never as a preview', () => {
    expect(previewDial({ framePort: LAN, lanPort: LAN, approved })).toEqual({ kind: 'lan' });
  });
});
