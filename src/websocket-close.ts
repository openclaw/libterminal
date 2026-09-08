const encoder = new TextEncoder();

export type CloseableWebSocket = {
  close(code?: number, reason?: string): void;
};

export function cleanReason(value: unknown): string {
  return truncateReason((typeof value === "string" ? value : "").trim());
}

function truncateReason(source: string): string {
  let result = "";
  let bytes = 0;
  for (const character of source) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > 123) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function validCloseCode(code: number): boolean {
  return (
    Number.isInteger(code) &&
    (code === 1000 ||
      (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
      (code >= 3000 && code <= 4999))
  );
}

export function safeClose(
  socket: CloseableWebSocket,
  code: number,
  reason: string,
  onError?: (error: unknown) => void,
): void {
  const safeCode = validCloseCode(code) ? code : 1000;
  const safeReason = truncateReason(reason);
  try {
    socket.close(safeCode, safeReason);
  } catch {
    try {
      socket.close(1000, safeReason);
    } catch {
      try {
        socket.close();
      } catch (error) {
        // Closing is best-effort after a peer has already failed.
        onError?.(error);
      }
    }
  }
}
