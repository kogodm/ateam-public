import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Register only when a Cursor Desktop bundle is installed; manual RPC retry is always available. */
export function autoRegisterCursorDesktop(
  home: string,
  connectorScript: string,
  register: (configPath: string) => unknown,
  exists: (path: string) => boolean = existsSync,
): boolean {
  if (!exists(connectorScript)) return false;
  const installed = ['/Applications/Cursor.app', join(home, 'Applications', 'Cursor.app')].some(
    exists,
  );
  if (!installed) return false;
  register(join(home, '.cursor', 'mcp.json'));
  return true;
}
