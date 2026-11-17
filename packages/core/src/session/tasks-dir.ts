import { join } from 'node:path';

/**
 * Where the harness keeps a session's task files — both the sub-agents'
 * conversations and the output of commands left running in the background.
 *
 * Derivable, not discoverable: /tmp/claude-<uid>/<project slug>/<parent claude
 * session id>/tasks, where the slug is the same non-alphanumeric-to-dash rule
 * that names ~/.claude/projects. Verified against a live run.
 */
export function sessionTasksDir(cwd: string, claudeSessionId: string): string {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return join('/tmp', `claude-${process.getuid?.() ?? 0}`, slug, claudeSessionId, 'tasks');
}

/** The harness's ids are short and flat; anything else must never reach a
 *  path join. */
export const isTaskId = (id: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(id);
