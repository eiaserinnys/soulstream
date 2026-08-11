import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

export interface SseEnvelope {
  event: string;
  id?: string;
  data: unknown;
}

export interface SseParseResult {
  frames: SseEnvelope[];
  tail: string;
}

export interface RunnerEvidenceManifest {
  sessionId: string;
  eventCount: number;
  journalCount: number;
  files: {
    events: string;
    journal: string;
  };
}

export function parseSseChunk(previousTail: string, chunk: string): SseParseResult {
  const combined = previousTail + chunk.replaceAll("\r\n", "\n");
  const blocks = combined.split("\n\n");
  const tail = blocks.pop() ?? "";
  const frames: SseEnvelope[] = [];
  for (const block of blocks) {
    const parsed = parseSseBlock(block);
    if (parsed) frames.push(parsed);
  }
  return { frames, tail };
}

export function fixtureCandidateFromEnvelope(envelope: SseEnvelope): Record<string, unknown> {
  return {
    source: "orch_sse",
    event: envelope.event,
    data: sanitizeFixtureValue(envelope.data, "data"),
  };
}

export async function exportRunnerEvidence(input: {
  sessionId: string;
  runnerStateDirectory: string;
  outputDirectory: string;
}): Promise<RunnerEvidenceManifest> {
  const slug = createHash("sha256").update(input.sessionId).digest("hex").slice(0, 24);
  const databasePath = join(input.runnerStateDirectory, slug, "runner.sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let events: Record<string, unknown>[];
  let journal: Record<string, unknown>[];
  try {
    events = database.prepare(
      "SELECT * FROM runner_event_outbox ORDER BY source_seq",
    ).all() as Record<string, unknown>[];
    journal = database.prepare(
      "SELECT * FROM runner_ipc_journal ORDER BY frame_seq",
    ).all() as Record<string, unknown>[];
  } finally {
    database.close();
  }
  await mkdir(input.outputDirectory, { recursive: true, mode: 0o700 });
  const eventsPath = join(input.outputDirectory, "runner-events.jsonl");
  const journalPath = join(input.outputDirectory, "runner-ipc-journal.jsonl");
  await writePrivateJsonLines(eventsPath, events.map(normalizeSqliteRow));
  await writePrivateJsonLines(journalPath, journal.map(normalizeSqliteRow));
  return {
    sessionId: input.sessionId,
    eventCount: events.length,
    journalCount: journal.length,
    files: { events: eventsPath, journal: journalPath },
  };
}

export async function writeFixtureCandidates(
  path: string,
  envelopes: readonly SseEnvelope[],
): Promise<number> {
  const unique = new Map<string, Record<string, unknown>>();
  for (const envelope of envelopes) {
    const candidate = fixtureCandidateFromEnvelope(envelope);
    const identity = JSON.stringify(candidate);
    unique.set(createHash("sha256").update(identity).digest("hex"), candidate);
  }
  await writePrivateJsonLines(path, [...unique.values()]);
  return unique.size;
}

function parseSseBlock(block: string): SseEnvelope | null {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  const raw = data.join("\n");
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // Non-JSON SSE data stays verbatim in the private raw archive.
  }
  return { event, ...(id ? { id } : {}), data: parsed };
}

function sanitizeFixtureValue(value: unknown, key: string): unknown {
  if (/authorization|token|secret|api[_-]?key|password/i.test(key)) return "<redacted>";
  if (/^(createdAt|created_at|updatedAt|updated_at|timestamp|resetsAt|progress_at)$/i.test(key)) {
    return "<timestamp>";
  }
  if (/^(agentSessionId|agent_session_id|sessionId|session_id)$/i.test(key)) {
    return "<session-id>";
  }
  if (/^(toolUseId|tool_use_id|correlationId|correlation_id|requestId|request_id)$/i.test(key)) {
    return "<opaque-id>";
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeFixtureValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        sanitizeFixtureValue(child, childKey),
      ]),
    );
  }
  return value;
}

function normalizeSqliteRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === "bigint" ? Number(value) : value,
  ]));
}

async function writePrivateJsonLines(
  path: string,
  records: readonly Record<string, unknown>[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const content = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(path, content.length > 0 ? `${content}\n` : "", { mode: 0o600 });
}
