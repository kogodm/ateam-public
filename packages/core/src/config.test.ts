import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, machineName, proxyEnv } from './config';

describe('proxy config', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-config-spec-'));
    prevHome = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('defaults to disabled with the conventional mixed port prefilled', () => {
    expect(loadConfig().proxy).toEqual({ enabled: false, url: '127.0.0.1:7890' });
    expect(proxyEnv()).toEqual({});
  });

  it('fans a bare host:port out per protocol (http for HTTP/S, socks5 for ALL)', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ version: 1, proxy: { enabled: true, url: ' 127.0.0.1:7890 ' } }),
    );
    expect(proxyEnv()).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      ALL_PROXY: 'socks5://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      http_proxy: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
      all_proxy: 'socks5://127.0.0.1:7890',
      no_proxy: 'localhost,127.0.0.1,::1',
    });
  });

  it('respects an explicit scheme verbatim everywhere (legacy config)', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ version: 1, proxy: { enabled: true, url: 'http://10.0.0.2:8888' } }),
    );
    expect(proxyEnv()).toEqual({
      HTTP_PROXY: 'http://10.0.0.2:8888',
      HTTPS_PROXY: 'http://10.0.0.2:8888',
      ALL_PROXY: 'http://10.0.0.2:8888',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      http_proxy: 'http://10.0.0.2:8888',
      https_proxy: 'http://10.0.0.2:8888',
      all_proxy: 'http://10.0.0.2:8888',
      no_proxy: 'localhost,127.0.0.1,::1',
    });
  });

  it('falls back to the default address when the saved url is blank', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ version: 1, proxy: { enabled: true, url: '  ' } }),
    );
    expect(proxyEnv()).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      ALL_PROXY: 'socks5://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      http_proxy: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
      all_proxy: 'socks5://127.0.0.1:7890',
      no_proxy: 'localhost,127.0.0.1,::1',
    });
  });

  it('emits nothing when a url is set but the toggle is off', () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ version: 1, proxy: { enabled: false, url: '127.0.0.1:7890' } }),
    );
    expect(proxyEnv()).toEqual({});
  });
});

describe('LAN password', () => {
  it('hashLanPassword yields the exact LanConfig fields and verifyLanPassword accepts them', async () => {
    const { hashLanPassword, verifyLanPassword } = await import('./config');
    const fields = hashLanPassword('hunter22');
    // spreading into the config must populate passwordHash/passwordSalt —
    // a {hash, salt} shape here meant the password never saved (#28)
    expect(Object.keys(fields).sort()).toEqual(['passwordHash', 'passwordSalt']);
    const cfg = { enabled: false, port: 4380, ...fields };
    expect(verifyLanPassword(cfg, 'hunter22')).toBe(true);
    expect(verifyLanPassword(cfg, 'wrong')).toBe(false);
    expect(
      verifyLanPassword({ enabled: false, port: 4380, passwordHash: '', passwordSalt: '' }, 'x'),
    ).toBe(false);
  });
});

/** A phone can be tunnelled into any of several machines; every client is
 *  told which one it reached, by the name the machine picker listed. */
describe('what this machine is called', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ateam-machine-spec-'));
    prevHome = process.env.ATEAM_HOME;
    process.env.ATEAM_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.ATEAM_HOME;
    else process.env.ATEAM_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  const cfg = (name: string) => ({
    ...loadConfig(),
    remote: {
      enabled: false,
      url: '',
      deviceId: '',
      token: '',
      tlsFingerprint: '',
      name,
      accountId: '',
      email: '',
    },
  });

  it('uses the name given at relay registration', () => {
    expect(machineName(cfg('Home iMac'))).toBe('Home iMac');
  });

  it('trims what the form let through', () => {
    expect(machineName(cfg('  Home iMac  '))).toBe('Home iMac');
  });

  it('falls back to the host name before any registration', () => {
    expect(machineName(cfg(''))).toBe(hostname());
    expect(machineName(cfg('   '))).toBe(hostname());
  });
});
