import { isRecord } from "./json_record.js";
import type { CallerInfo, CallerInfoSource } from "../generated/typescript/index.js";

const IDENTITY_BEARING_CALLER_SOURCES: ReadonlySet<CallerInfoSource> = new Set([
  "agent",
  "system",
  "slack",
  "soul-app",
  "channel_observer",
  "llm",
  "external",
]);

export function hasCallerIdentity(callerInfo: CallerInfo): boolean {
  const source = callerInfo.source;
  const displayName = callerInfo.display_name;
  const avatarUrl = callerInfo.avatar_url;
  return (
    (typeof source === "string" && IDENTITY_BEARING_CALLER_SOURCES.has(source)) ||
    (typeof displayName === "string" && displayName.length > 0) ||
    (typeof avatarUrl === "string" && avatarUrl.length > 0)
  );
}

export function extractCallerInfo(metadata: unknown): CallerInfo | undefined {
  if (!Array.isArray(metadata)) return undefined;
  let lastAny: CallerInfo | undefined;
  let lastWithIdentity: CallerInfo | undefined;
  for (const entry of metadata) {
    if (!isRecord(entry) || entry.type !== "caller_info") continue;
    if (!isRecord(entry.value)) continue;
    const callerInfo = entry.value as CallerInfo;
    lastAny = callerInfo;
    if (hasCallerIdentity(callerInfo)) lastWithIdentity = callerInfo;
  }
  return lastWithIdentity ?? lastAny;
}
