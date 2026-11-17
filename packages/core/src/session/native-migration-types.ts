export interface NativeMigrationMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface NativeMigrationResult {
  sessionId: string;
  path: string;
}
