import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GeneralPane,
  RemoteSettingsPane,
  RemoteSettingsSectionTabs,
  SETTINGS_NAV,
} from './Settings';
import { RemoteAccessSettingsLink, SyncPane } from './SettingsSync';
import type { Rpc } from './rpc';

vi.mock('./Tip', () => ({
  Tip: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const rpc = { request: vi.fn() } as unknown as Rpc;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Remote settings page', () => {
  it('keeps Sync out of the top-level navigation and places Remote after General', () => {
    const ids = SETTINGS_NAV.map((item) => item.id);
    expect(ids).not.toContain('sync');
    expect(ids[ids.indexOf('general') + 1]).toBe('remote');
  });

  it('renders LAN and relay settings on Remote, not on General', () => {
    vi.stubGlobal('__APP_VERSION__', '0.8.0');
    vi.stubGlobal('__BUILD_ID__', 'test');
    const general = renderToStaticMarkup(
      <GeneralPane rpc={rpc} activeWindowH={24} setActiveWindowH={vi.fn()} />,
    );
    const remote = renderToStaticMarkup(<RemoteSettingsPane rpc={rpc} />);

    expect(general).not.toContain('LAN access');
    expect(general).not.toContain('Remote access');
    expect(remote).toContain('<h1 class="page-title">Remote</h1>');
    expect(remote).toContain('aria-label="Remote settings sections"');
    expect(remote).toContain('aria-pressed="true">Access</button>');
    expect(remote).toContain('aria-pressed="false">Sync</button>');
    expect(remote.indexOf('LAN access')).toBeGreaterThan(-1);
    expect(remote.indexOf('LAN access')).toBeLessThan(remote.indexOf('Remote access'));
    expect(remote).not.toContain('<h2 class="section-title">Sync</h2>');
  });

  it('renders the embedded Sync section with its own heading and status content', () => {
    const sync = renderToStaticMarkup(
      <SyncPane rpc={rpc} onOpenRemote={vi.fn()} embedded />,
    );

    expect(sync).toContain('<h2 class="section-title">Sync</h2>');
    expect(sync).not.toContain('<h1 class="page-title">Sync</h1>');
    expect(sync).toContain('Status');
  });

  it('routes the Remote section buttons through their section callback', () => {
    const onChange = vi.fn();
    const tabs = RemoteSettingsSectionTabs({ section: 'access', onChange });

    expect(renderToStaticMarkup(tabs)).toContain('Access');
    expect(renderToStaticMarkup(tabs)).toContain('Sync');
    tabs.props.children[1].props.onClick();
    expect(onChange).toHaveBeenCalledWith('sync');
  });

  it('keeps account credentials inside the closed modal on the Remote page', () => {
    const remote = renderToStaticMarkup(<RemoteSettingsPane rpc={rpc} />);

    expect(remote).toContain('Sign in / Register');
    expect(remote).toContain('Connected');
    expect(remote).toContain('class="toggle-switch');
    expect(remote).toContain('Remote access');
    expect(remote).not.toContain('id="remote-auth-email"');
    expect(remote).not.toContain('id="remote-auth-password"');
    expect(remote).not.toContain('id="remote-auth-invite"');
    expect(remote).not.toContain('Register &amp; connect');
    expect(remote).not.toContain('Register & connect');
  });

  it('keeps LAN password and port fields inside the closed LAN dialog while disabled', () => {
    const remote = renderToStaticMarkup(<RemoteSettingsPane rpc={rpc} />);

    expect(remote).toContain('Enable LAN access');
    expect(remote).toContain('class="toggle-switch');
    expect(remote).not.toContain('id="lan-dialog-password"');
    expect(remote).not.toContain('id="lan-dialog-port"');
    expect(remote).not.toContain('class="modal lan-modal"');
    expect(remote).not.toContain('Configure LAN');
  });

  it('provides a Sync link that opens Remote access settings', () => {
    const onOpenRemote = vi.fn();
    const link = RemoteAccessSettingsLink({ onOpenRemote });

    expect(renderToStaticMarkup(link)).toContain('Remote → Remote access');
    link.props.onClick();
    expect(onOpenRemote).toHaveBeenCalledOnce();
  });
});
