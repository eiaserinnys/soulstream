export function applyToolContentPolicy(
  ev: { id: number; event_type: string; payload: Record<string, unknown>; created_at: Date },
  policy: "truncate" | "full" | "omit",
  truncateChars: number,
): Record<string, unknown> {
  const isToolEvent =
    ev.event_type === "tool_use" || ev.event_type === "tool_result";
  let payload: Record<string, unknown> | string = ev.payload;
  if (isToolEvent) {
    if (policy === "omit") {
      payload = "(omitted)";
    } else if (policy === "truncate") {
      const text = JSON.stringify(ev.payload);
      payload =
        text.length > truncateChars
          ? `${text.slice(0, truncateChars)}…(truncated)`
          : text;
    }
  }
  return {
    id: ev.id,
    event_type: ev.event_type,
    event: payload,
    created_at: ev.created_at instanceof Date ? ev.created_at.toISOString() : ev.created_at,
  };
}
