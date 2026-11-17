/**
 * Sub-agents that are still working when a session hands off go with it.
 *
 * A sub-agent runs inside its session's claude process, so killing the old
 * session at a hand-off killed every one of them and their results were lost.
 * It cannot be moved while it runs, but it can be continued: measured on CLI
 * 2.1.285 (docs/sessions/subagent-carryover-probe.md), copying
 * `subagents/agent-<id>.jsonl` and its `.meta.json` into the successor's own
 * `subagents/` directory is enough for the successor's
 * `SendMessage(to: <id>)` to pick the agent up with its whole context. The
 * probe agent was stopped in step 3, remembered its secret word, did not redo
 * step 3, and finished steps 4 and 5. The copy has to wait until the old
 * process is gone, because dying it still writes the interrupted tool's
 * result (`Exit code 137`) into the agent's log.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type SubagentInfo, listSubagents } from './subagents';
import { transcriptPath } from './transcript-file';

/** `<project>/<sessionId>/subagents` — where a session's agent logs live */
export function subagentsDir(cwd: string, claudeSessionId: string): string {
  return join(transcriptPath(cwd, claudeSessionId).replace(/\.jsonl$/, ''), 'subagents');
}

/** the sub-agents of a session that have not given their final answer */
export function runningSubagents(cwd: string, claudeSessionId: string): SubagentInfo[] {
  return listSubagents(cwd, claudeSessionId).filter((a) => !a.done);
}

/** Copy each agent's log and meta into the successor's `subagents/`.
 *  Returns the ids whose log was copied. */
export function copySubagents(
  from: { cwd: string; claudeSessionId: string },
  to: { cwd: string; claudeSessionId: string },
  agentIds: readonly string[],
): string[] {
  const src = subagentsDir(from.cwd, from.claudeSessionId);
  const dst = subagentsDir(to.cwd, to.claudeSessionId);
  const copied: string[] = [];
  for (const id of agentIds) {
    const log = join(src, `agent-${id}.jsonl`);
    if (!existsSync(log)) continue;
    try {
      mkdirSync(dst, { recursive: true });
      copyFileSync(log, join(dst, `agent-${id}.jsonl`));
      // without the meta the agent resumes on the parent's model and loses
      // its name — both files, always
      const meta = join(src, `agent-${id}.meta.json`);
      if (existsSync(meta)) copyFileSync(meta, join(dst, `agent-${id}.meta.json`));
      copied.push(id);
    } catch {
      /* unreadable or unwritable: that agent stays behind */
    }
  }
  return copied;
}

/** The part of the successor's first message that tells it about them. */
export function subagentCarryoverBlock(agents: readonly SubagentInfo[]): string {
  if (agents.length === 0) return '';
  return [
    '',
    '--- SUB-AGENTS CARRIED OVER ---',
    'These sub-agents were still working when the previous session handed off. The hand-off stopped them mid-task; their conversations have been moved to this session, so they can continue with everything they knew. Once you have read the hand-off, continue each one with SendMessage, e.g. SendMessage(to: "<id>", message: "The session you worked for handed off to me and you were stopped mid-task. Continue from where you stopped and report as before."). If SendMessage says no transcript was found, wait a few seconds and try again: the move finishes just after this session starts. Do not start new agents for this work.',
    ...agents.map(
      (a) => `- ${a.agentId} — ${a.label || a.task.slice(0, 120) || 'sub-agent'}`,
    ),
    '--- END SUB-AGENTS ---',
  ].join('\n');
}
