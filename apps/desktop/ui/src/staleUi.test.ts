import { describe, expect, it } from 'vitest';
import { scriptPathsIn, servedUiIsNewer } from './staleUi';

const html = (chunk: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/assets/${chunk}"></script><link rel="stylesheet" href="/assets/index-abc.css"></head><body><div id="root"></div></body></html>`;

describe('servedUiIsNewer', () => {
  it('spots a rebuilt UI by its content-hashed chunk name', () => {
    // the desktop was upgraded under a phone that only lost its socket
    expect(servedUiIsNewer(html('index-B8h6JqSv.js'), ['/assets/index-C1cdAzaE.js'])).toBe(true);
  });

  it('says nothing changed when the same build is still being served', () => {
    expect(servedUiIsNewer(html('index-B8h6JqSv.js'), ['/assets/index-B8h6JqSv.js'])).toBe(false);
  });

  it('leading ./ or / is not a difference', () => {
    expect(servedUiIsNewer(html('index-B8h6JqSv.js'), ['assets/index-B8h6JqSv.js'])).toBe(false);
  });

  it('refuses to judge a page with no scripts — a login gate is not an upgrade', () => {
    // the LAN password page has an INLINE script and no src: reloading on it
    // would spin the phone in a loop instead of showing the form
    expect(servedUiIsNewer('<html><body><script>doLogin()</script></body></html>', [])).toBe(false);
  });

  it('reads every module script, not just the first', () => {
    expect(
      scriptPathsIn(`${html('index-a.js')}<script src="/assets/vendor-b.js"></script>`),
    ).toEqual(['assets/index-a.js', 'assets/vendor-b.js']);
  });
});
