export interface OrchErrorEnvelope {
  message: string;
  code: string | null;
  details: Record<string, unknown>;
}


export function readOrchErrorEnvelopeText(status: { status: number; statusText: string }, text: string): OrchErrorEnvelope {
  const fallback = text || `${status.status} ${status.statusText}`;
  if (!text) return { message: fallback, code: null, details: {} };
  try {
    const payload: unknown = JSON.parse(text);
    if (!isRecord(payload)) return { message: fallback, code: null, details: {} };
    const detail = payload.detail;
    if (typeof detail === "string") {
      return { message: detail, code: null, details: {} };
    }
    const envelope = isRecord(detail) ? detail : payload;
    const error = isRecord(envelope.error) ? envelope.error : envelope;
    const details = isRecord(error.details) ? error.details : {};
    return {
      message: typeof error.message === "string" ? error.message : fallback,
      code: typeof error.code === "string" ? error.code : null,
      details,
    };
  } catch {
    return { message: fallback, code: null, details: {} };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
