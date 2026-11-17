import { claudeAdapter } from './claude-adapter';
import { codexAdapter } from './codex-adapter';
import { cursorAdapter } from './cursor-adapter';
import { opencodeAdapter } from './opencode-adapter';
import type { ProviderAdapter, ProviderId } from './provider-adapter';

const REGISTRY: Record<ProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  cursor: cursorAdapter,
};

export function getAdapter(id: ProviderId): ProviderAdapter {
  return REGISTRY[id];
}

export type { ProviderAdapter, ProviderBuildArgs, ProviderId } from './provider-adapter';
export { ProviderNotImplementedError } from './provider-adapter';
