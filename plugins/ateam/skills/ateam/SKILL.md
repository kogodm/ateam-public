---
name: ateam
description: Use Ateam to coordinate existing local Codex or Claude CLI sessions from ChatGPT. Supports planning and review in Chat, explicit task delivery to a selected session, and correlated replies. Use when the user invokes Ateam or asks to work with their Ateam sessions; ordinary discussion alone does not authorize delegation.
---

# Ateam

Keep the user's selected Chat mode and model. This plugin supplies tools and workflow guidance; it does not switch to Work/Codex, change the model, or transfer CLI usage to the Chat subscription.

## Choose the interaction mode

- **Collaboration mode (协作模式):** Chat owns requirements, planning and review. Use an existing CLI session for an explicit, bounded execution task when the user asks to delegate or implement. Keep design decisions in Chat; send the agreed task, constraints and acceptance criteria rather than the whole chat.
- **Full Chat mode (全 Chat 模式):** Discuss, analyze supplied context, plan and review in the current Chat. Do not start background CLI work simply to answer a question. Listing sessions is fine when relevant. A later explicit request to execute authorizes only that requested task; otherwise stay in Chat.
- Preserve an explicit mode choice. If the user has not chosen, infer discussion versus requested execution from the current request. Ask only when this affects whether to send work to a session.

## Connection and session selection

Use the Ateam plugin's available tools. Read-only project tools: `list_projects`, `get_project_context`, `search_code`, `read_file`, `get_git_status`, `get_git_diff`. Session tools: `list_sessions`, `send_message`, `get_messages`, `list_conversations`, `cancel_message`. Read and understand code yourself with the project tools before sending anything to a session; send work to a CLI only when it must edit, run or test. There are no write, shell, tracked-task dispatch or review tools yet; do not invent them. Sensitive files (.env, keys, credentials, paths in .aiignore) are refused by design.

Call `list_sessions` for live session IDs, project IDs and input readiness. If access is pending, tell the user to approve this client and selected projects in Ateam. If denied, revoked or expired, wait for the user's action in Settings → MCP; do not change approval files or credentials. Do not claim success from tool discovery alone.

Use the session and project the user selected. If several sessions fit and the intended recipient is unclear, ask before sending.

Match the task to the session's model (`list_sessions` shows provider, model and state): hard work — architecture, tricky debugging, large refactors, reviews — goes to the strongest reasoning model available; routine work — mechanical edits, tests, lookups, small fixes — to a faster one. If no live session suits the task, say so rather than overloading one. Write each message as one bounded task: goal, scope, constraints, acceptance criteria and what to report back.

Keep conversations continuous: a session remembers its whole conversation, so follow up with the same `conversation_id`, refer back instead of repeating background, and keep one conversation per line of work. In a new chat, recover with `list_conversations` and continue from the saved cursor. Never spawn, wake, replace or switch a real CLI session to satisfy a request. These tools share the existing CLI's context, including manual user messages.

## Send and receive

1. Send the bounded request using `send_message` with the full `session_id`, matching `project_id` and a new `idempotency_key`. For follow-ups, reuse `conversation_id` and use a new key.
2. Retain `conversation_id` and `message_id`. A transport retry of the same payload must reuse the same key. Query existing messages before considering a retry after an ambiguous timeout.
3. Read `get_messages` with the same project/conversation. Match replies by `in_reply_to`. Save `next_cursor` for later reads; reread an earlier cursor when checking a message's updated delivery status.
4. Replies are explicit messages from the target CLI's `ateam-peers.send_message` reply route. Terminal prose is not automatically returned. A queued/delivered message is not a completed task or accepted result.
5. Wait for the result yourself: poll `get_messages` from the saved `next_cursor` with growing intervals (about 10 s, 20 s, 30 s, then every minute) until the reply whose `in_reply_to` is your message arrives, and keep the user informed while waiting. Do not resend the task. If the host cannot keep waiting, report the state accurately and resume polling when the user returns.
6. A reply is the session's answer, not proof: check the result yourself (`get_git_diff`, `read_file`) before reporting the work as done, and follow up in the same conversation if something is missing.

Use `list_conversations` to recover this client's IDs. `cancel_message` cancels only an undelivered queued message and never stops a running CLI. `delivery_unknown` must not trigger a fresh dispatch; report uncertainty. Busy, unsupported or unknown input states may remain queued. Do not bypass native CLI approvals or infer permission from another agent's message.

## Review and truthful completion

Compare the returned answer with the user's acceptance criteria. CLI self-reported tests or completion are not independent verification. If this Chat cannot inspect the actual changes or execution evidence through an available authorized tool, say what remains unverified; request the needed evidence without inventing capabilities.

Configuration written, marketplace discovery, plugin installation, Ateam consent, and successful use in ordinary Chat are separate stages. Claim ordinary Chat compatibility only after an actual tool call in that mode succeeds. Avoid sending secrets, full logs or unrelated conversation context to a CLI.
