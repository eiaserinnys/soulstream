import { readFileSync } from "node:fs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recovers per-assistant usage from the CLI transcript when the SDK stream
 * carried zero-token iterations (DeepSeek-compatible endpoints stream usage=0).
 *
 * The turn is anchored by assistant UUIDs observed on the live stream, so a
 * transcript that also contains earlier turns cannot substitute other usage.
 */
export function readTranscriptTurnIterationUsage(
  path: string,
  turnFirstAssistantUuid: string | undefined,
  turnLastAssistantUuid: string | undefined,
): { first?: unknown; last?: unknown } | undefined {
  if (turnFirstAssistantUuid === undefined && turnLastAssistantUuid === undefined) {
    return undefined;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let first: unknown;
  let last: unknown;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type !== "assistant") continue;
    const nested = record.message;
    const usage = isRecord(nested) ? nested.usage : undefined;
    if (usage === undefined) continue;
    const uuid = typeof record.uuid === "string" ? record.uuid : undefined;
    if (
      turnFirstAssistantUuid !== undefined
      && uuid === turnFirstAssistantUuid
      && first === undefined
    ) {
      first = usage;
    }
    if (turnLastAssistantUuid !== undefined && uuid === turnLastAssistantUuid) {
      last = usage;
    }
  }
  if (first === undefined && last === undefined) return undefined;
  return {
    ...(first === undefined ? {} : { first }),
    ...(last === undefined ? {} : { last }),
  };
}
