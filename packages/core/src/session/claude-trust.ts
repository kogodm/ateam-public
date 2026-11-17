import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Pre-accept Claude Code's workspace-trust dialog for a directory.
 *
 * On the first session in a directory Claude Code has never seen, the CLI
 * shows a blocking "Is this a project you trust?" prompt and waits for Enter.
 * In a normal session the user sees the terminal and answers it — but a chat
 * teammate's session is HIDDEN (chat mode), so the prompt can never be
 * answered and the teammate hangs forever, producing no transcript and no
 * reply. The user picking a directory for a chat IS the trust decision, so we
 * record it the same way accepting the dialog would: set
 * projects[dir].hasTrustDialogAccepted = true in ~/.claude.json.
 *
 * Best-effort and careful: read-modify-write with an atomic rename, and never
 * throw — if ~/.claude.json is missing or unparsable we simply skip (the
 * worst case is the pre-existing prompt behaviour).
 */
export function ensureClaudeProjectTrusted(cwd: string): void {
  if (!cwd) return;
  const path = join(homedir(), '.claude.json');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return; // no config yet / unreadable — leave Claude to its own defaults
  }
  const projects = (json.projects ?? {}) as Record<string, Record<string, unknown>>;
  const existing = projects[cwd];
  if (existing && existing.hasTrustDialogAccepted === true) return; // already trusted
  projects[cwd] = { ...(existing ?? {}), hasTrustDialogAccepted: true };
  json.projects = projects;
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(json, null, 2));
    renameSync(tmp, path); // atomic; a concurrent Claude never sees a half file
  } catch {
    /* write failed — the prompt just reappears, no worse than before */
  }
}
