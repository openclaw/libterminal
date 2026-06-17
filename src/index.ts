export type TerminalSize = {
  columns: number;
  rows: number;
};

export type TerminalExit = {
  code: number | null;
  signal: string | number | null;
};

export type TerminalOutput = {
  sessionId: string;
  bytes: Uint8Array;
};

export interface TerminalDuplex {
  output: AsyncIterable<Uint8Array>;
  write?(bytes: Uint8Array): Promise<void>;
  resize?(size: TerminalSize): Promise<void>;
  close(reason?: string): Promise<void>;
}

export type LibterminalErrorCode =
  | "invalid_frame"
  | "unsupported_protocol"
  | "invalid_terminal_size"
  | "subscriber_overflow"
  | "transport_closed"
  | "control_revoked"
  | "pty_unavailable"
  | "ghostty_unavailable";

export class LibterminalError extends Error {
  readonly code: LibterminalErrorCode;
  readonly cause?: unknown;

  constructor(code: LibterminalErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "LibterminalError";
    this.code = code;
    this.cause = options?.cause;
  }
}

export function assertTerminalSize(size: TerminalSize): TerminalSize {
  if (
    !Number.isSafeInteger(size.columns) ||
    !Number.isSafeInteger(size.rows) ||
    size.columns < 1 ||
    size.rows < 1 ||
    size.columns > 65_535 ||
    size.rows > 65_535
  ) {
    throw new LibterminalError(
      "invalid_terminal_size",
      `terminal size must be integer columns and rows between 1 and 65535`,
    );
  }
  return size;
}
