import { expect, it, vi } from 'vitest';
import { autoRegisterCursorDesktop } from './cursor-desktop-registration';

it('auto-registers the global Cursor config only when an app bundle and connector exist', () => {
  const home = '/Users/test';
  const register = vi.fn();
  const paths = new Set(['/Applications/Cursor.app', '/bundle/mcp-desktop.cjs']);
  expect(
    autoRegisterCursorDesktop(home, '/bundle/mcp-desktop.cjs', register, (p) => paths.has(p)),
  ).toBe(true);
  expect(register).toHaveBeenCalledWith('/Users/test/.cursor/mcp.json');
});

it('detects Cursor installed in the current user Applications directory', () => {
  const home = '/Users/test';
  const register = vi.fn();
  const paths = new Set([`${home}/Applications/Cursor.app`, '/bundle/mcp-desktop.cjs']);
  expect(
    autoRegisterCursorDesktop(home, '/bundle/mcp-desktop.cjs', register, (p) => paths.has(p)),
  ).toBe(true);
  expect(register).toHaveBeenCalledWith(`${home}/.cursor/mcp.json`);
});

it('skips automatic registration when neither supported Cursor app path exists', () => {
  const register = vi.fn();
  const paths = new Set(['/bundle/mcp-desktop.cjs']);
  expect(
    autoRegisterCursorDesktop('/Users/test', '/bundle/mcp-desktop.cjs', register, (p) =>
      paths.has(p),
    ),
  ).toBe(false);
  expect(register).not.toHaveBeenCalled();
});

it('does not register if the bundled connector is missing', () => {
  const register = vi.fn();
  expect(
    autoRegisterCursorDesktop(
      '/Users/test',
      '/missing/mcp-desktop.cjs',
      register,
      (path) => path === '/Applications/Cursor.app',
    ),
  ).toBe(false);
  expect(register).not.toHaveBeenCalled();
});
