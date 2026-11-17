import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OAuthError, OAuthStore, basicClientId, granteeFor } from './external-oauth';

describe('external-oauth Gemini Web support', () => {
  it('maps Gemini and Google OAuth redirect URIs to gemini-web', () => {
    expect(granteeFor('https://oauth-redirect.googleusercontent.com/r/ateam')).toEqual({
      id: 'gemini-web',
      name: 'Gemini (web connector)',
    });
    expect(granteeFor('https://oauth-redirect-sandbox.googleusercontent.com/r/ateam')).toEqual({
      id: 'gemini-web',
      name: 'Gemini (web connector)',
    });
    expect(granteeFor('https://oauth-redirect-test.googleusercontent.com/a/ateam')).toEqual({
      id: 'gemini-web',
      name: 'Gemini (web connector)',
    });
    expect(granteeFor('https://vertexaisearch.cloud.google.com/oauth-redirect')).toEqual({
      id: 'gemini-web',
      name: 'Gemini (web connector)',
    });
    expect(granteeFor('https://gemini.google.com/callback')).toEqual({
      id: 'gemini-web',
      name: 'Gemini (web connector)',
    });
    expect(granteeFor('https://evil.example/cb')).toBeUndefined();
    expect(granteeFor('http://oauth-redirect.googleusercontent.com/r/ateam')).toBeUndefined();
  });

  it('registers Gemini DCR clients with multiple redirect URIs and optional client_secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ateam-oauth-test-'));
    try {
      const store = new OAuthStore(join(dir, 'oauth.json'));
      const uris = [
        'https://oauth-redirect.googleusercontent.com/r/ateam',
        'https://oauth-redirect-sandbox.googleusercontent.com/r/ateam',
        'https://oauth-redirect-test.googleusercontent.com/r/ateam',
        'https://oauth-redirect.googleusercontent.com/a/ateam',
        'https://oauth-redirect-sandbox.googleusercontent.com/a/ateam',
        'https://oauth-redirect-test.googleusercontent.com/a/ateam',
      ];
      const reg = store.register({
        client_name: 'Gemini Web',
        redirect_uris: uris,
        token_endpoint_auth_method: 'client_secret_basic',
      });
      expect(reg.client_id).toBeTruthy();
      expect(reg.client_secret).toBeTruthy();
      expect(reg.redirect_uris).toEqual(uris);
      expect(reg.token_endpoint_auth_method).toBe('client_secret_basic');

      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const grantee = store.checkAuthorize({
        client_id: reg.client_id,
        redirect_uri: uris[0],
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      expect(grantee.id).toBe('gemini-web');

      const code = store.issueCode({
        oauthClient: reg.client_id,
        redirectUri: uris[0] as string,
        challenge,
        grantee: grantee.id,
        grantedAt: Date.now(),
      });
      const tokens = store.exchangeCode({
        code,
        code_verifier: verifier,
        client_id: reg.client_id,
        redirect_uri: uris[0],
      });
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.refresh_token).toBeTruthy();
      expect(store.verify(`Bearer ${tokens.access_token}`)?.grantee).toBe('gemini-web');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports manual Client ID and Basic auth extraction for Gemini Connected Apps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ateam-oauth-manual-'));
    try {
      const store = new OAuthStore(join(dir, 'oauth.json'));
      const redirectUri = 'https://oauth-redirect.googleusercontent.com/r/custom-app';
      const grantee = store.checkAuthorize({
        client_id: 'my-manual-client-id',
        redirect_uri: redirectUri,
        response_type: 'code',
      });
      expect(grantee.id).toBe('gemini-web');

      const code = store.issueCode({
        oauthClient: 'my-manual-client-id',
        redirectUri,
        challenge: '',
        grantee: grantee.id,
        grantedAt: Date.now(),
      });
      const header = `Basic ${Buffer.from('my-manual-client-id:my-secret').toString('base64')}`;
      expect(basicClientId(header)).toBe('my-manual-client-id');

      const tokens = store.exchangeCode({
        code,
        client_id: basicClientId(header),
        redirect_uri: redirectUri,
      });
      expect(tokens.access_token).toBeTruthy();
      const rotated = store.refresh({
        refresh_token: tokens.refresh_token,
        client_id: basicClientId(header),
      });
      expect(rotated.access_token).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still rejects unknown redirect hosts and preserves strict ChatGPT/Claude checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ateam-oauth-reject-'));
    try {
      const store = new OAuthStore(join(dir, 'oauth.json'));
      expect(() =>
        store.register({ redirect_uris: ['https://attacker.example/cb'] }),
      ).toThrowError(OAuthError);
      expect(() =>
        store.checkAuthorize({
          client_id: 'unknown',
          redirect_uri: 'https://attacker.example/cb',
          response_type: 'code',
        }),
      ).toThrowError(OAuthError);

      // ChatGPT and Claude still require prior /oauth/register and strict PKCE S256
      expect(() =>
        store.checkAuthorize({
          client_id: 'unregistered-chatgpt',
          redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
          response_type: 'code',
          code_challenge: 'abc',
          code_challenge_method: 'S256',
        }),
      ).toThrowError(OAuthError);

      const chatgptReg = store.register({
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      });
      expect(chatgptReg.token_endpoint_auth_method).toBe('none');
      expect(() =>
        store.checkAuthorize({
          client_id: chatgptReg.client_id,
          redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
          response_type: 'code',
        }),
      ).toThrowError(OAuthError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
