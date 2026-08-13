/** Classifies expected Node.js and ws handshake connection failures. */
export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH"
  ) {
    return true;
  }
  const msg = err.message;
  return (
    msg.includes("Unexpected server response") ||
    msg.includes("WebSocket") ||
    msg.includes("handshake")
  );
}
