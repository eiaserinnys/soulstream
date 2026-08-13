const COUNTABLE_FIELDS = [
  "sessions",
  "folders",
  "events",
  "items",
  "entries",
  "tasks",
  "agents",
  "schedules",
  "running_session_ids",
] as const;

export interface LogPayloadSummary {
  messageType: string | null;
  payloadBytes: number | null;
  itemCount?: number;
  itemCountField?: string;
  serializationError?: string;
}

export function summarizePayloadForLog(payload: unknown): LogPayloadSummary {
  const record = isRecord(payload) ? payload : undefined;
  const summary: LogPayloadSummary = {
    messageType: typeof record?.type === "string" ? record.type : null,
    payloadBytes: null,
  };
  try {
    const serialized = JSON.stringify(payload);
    if (serialized !== undefined) summary.payloadBytes = Buffer.byteLength(serialized);
    else summary.serializationError = "not_json_serializable";
  } catch (error) {
    summary.serializationError = error instanceof Error ? error.name : "unknown";
  }
  if (!record) return summary;
  for (const field of COUNTABLE_FIELDS) {
    const collection = record[field];
    if (!Array.isArray(collection)) continue;
    summary.itemCount = collection.length;
    summary.itemCountField = field;
    break;
  }
  return summary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
