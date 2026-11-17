export interface ExternalMcpStatus {
  chatgptPlugin?: ChatgptPluginStatus;
  endpoint: string;
  error?: string;
  registered: boolean;
  clients: {
    id: string;
    name: string;
    status: 'registered' | 'pending' | 'approved' | 'denied' | 'revoked' | 'expired';
    projects: string[];
    /** per project root: actions approved through request_project_access */
    capabilities?: Record<string, string[]>;
    connected: boolean;
  }[];
  /** `pairingCode` marks a remote OAuth sign-in; the same code is shown on the web page. */
  pending: { id: string; name: string; expiresAt: number; pairingCode?: string }[];
  projects: string[];
  /** granted project roots that no longer exist on disk (skipped, not served) */
  staleProjects?: string[];
  /** project access requests from clients, waiting for the user */
  requests?: {
    id: string;
    client: string;
    root: string;
    capabilities: string[];
    reason: string;
    expiresAt: number;
  }[];
  /** Public HTTPS endpoint for web connectors (Cloudflare Tunnel); absent when not configured. */
  publicMcp?: PublicMcpStatus;
}

export interface PublicMcpStatus {
  url: string;
  tunnel: 'starting' | 'running' | 'error' | 'missing-cloudflared';
  error?: string;
}

export interface ChatgptPluginStatus {
  packageWritten: boolean;
  marketplaceRegistered: boolean;
  discovered: boolean;
  installed: boolean;
  ordinaryChatVerified: false;
  marketplaceRoot: string;
  pluginId: string;
  error?: string;
}
