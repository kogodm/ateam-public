/**
 * Frozen wire envelope. Three message kinds over a single channel, all JSON,
 * all carrying `v` (protocol version). Additive changes (new methods/events/
 * optional fields) do NOT bump `v`; removals/renames/required-field changes do.
 */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/** request: client -> server */
export interface ReqEnvelope {
  readonly v: ProtocolVersion;
  readonly kind: 'req';
  readonly id: string;
  readonly method: string;
  readonly params: unknown;
}

/** response: server -> client (terminal for that id) */
export interface ResOkEnvelope {
  readonly v: ProtocolVersion;
  readonly kind: 'res';
  readonly id: string;
  readonly ok: true;
  readonly result: unknown;
}

export interface ResErrEnvelope {
  readonly v: ProtocolVersion;
  readonly kind: 'res';
  readonly id: string;
  readonly ok: false;
  readonly error: ProtocolError;
}

export type ResEnvelope = ResOkEnvelope | ResErrEnvelope;

/** event: server -> client (0..N, optionally correlated to a req id) */
export interface EvtEnvelope {
  readonly v: ProtocolVersion;
  readonly kind: 'evt';
  readonly topic: string;
  /** correlation id tying a stream of events to the originating request */
  readonly corr?: string;
  /** per-stream monotonic counter so the UI can detect gaps/order */
  readonly seq: number;
  readonly data: unknown;
}

export type Envelope = ReqEnvelope | ResEnvelope | EvtEnvelope;

export interface ProtocolError {
  readonly code: string;
  readonly message: string;
  readonly data?: unknown;
}

/** Well-known error codes. */
export const ErrorCode = {
  ProtocolVersion: 'protocol_version',
  BadRequest: 'bad_request',
  UnknownMethod: 'unknown_method',
  NotFound: 'not_found',
  Internal: 'internal',
  Unauthorized: 'unauthorized',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
