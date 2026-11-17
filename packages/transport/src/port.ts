/**
 * A Port is a minimal bidirectional JSON message channel. The transport-
 * agnostic RpcServer (in @ateam/core) speaks the contract over a Port; the
 * concrete Port may be in-process (embedded TUI), a WebSocket connection
 * (`ateam serve` + remote client / future Tauri), etc.
 */
export type MessageHandler = (msg: unknown) => void;
export type CloseHandler = () => void;

export interface Port {
  /** Send one JSON-serializable message to the peer. No-op if closed. */
  send(msg: unknown): void;
  /** Subscribe to inbound messages. Returns an unsubscribe function. */
  onMessage(cb: MessageHandler): () => void;
  /** Subscribe to close. Returns an unsubscribe function. */
  onClose(cb: CloseHandler): () => void;
  /** Close this side of the channel. */
  close(): void;
}
