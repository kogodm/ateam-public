/**
 * Whether a model name belongs to claude's family.
 *
 * A Human's `model` binding is one string, but a Human can run on either
 * runtime (the handoff dialog, a provider switch). `codex -m sonnet` gets a
 * 400 from the API on every turn — "The 'sonnet' model is not supported when
 * using Codex with a ChatGPT account" — and codex's own usage-limit picker
 * then offers "keep current model" = sonnet again (2026-09-14). So each
 * adapter only passes a binding that belongs to it; otherwise the runtime's
 * own default applies.
 */
const CLAUDE_MODEL =
  /^(?:claude[-_.]|(?:fable|opus|sonnet|haiku|mythos|opusplan|default|best)(?:\[1m\]|[-\d.\s]|$))/i;

export function isClaudeModel(model: string): boolean {
  return CLAUDE_MODEL.test(model.trim());
}
