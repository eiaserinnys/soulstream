import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { EventIngressEnvelope } from "./event_ingress_types.js";

export const EVENT_INGRESS_SESSION_NOT_FOUND = "SESSION_NOT_FOUND" as const;
export const EVENT_INGRESS_REPEATED_FAILURE = "REPEATED_FAILURE" as const;

export type EventIngressDeadLetterCode =
  | typeof EVENT_INGRESS_SESSION_NOT_FOUND
  | typeof EVENT_INGRESS_REPEATED_FAILURE;

export type EventIngressFailureDetail = {
  reason: string;
  errorName: string;
  errorCode?: string;
};

type LegacyEventIngressDeadLetterRecord = {
  code: typeof EVENT_INGRESS_SESSION_NOT_FOUND;
  reason: string;
  rejected_at: string;
  node_id: string;
  envelope: EventIngressEnvelope;
};

export type EventIngressFailureRecord = {
  version: 2;
  state: "retrying" | "dead_lettered";
  code: typeof EVENT_INGRESS_REPEATED_FAILURE;
  reason: string;
  rejected_at: string | null;
  node_id: string;
  envelope: EventIngressEnvelope;
  failure_count: number;
  failures: Array<{
    failed_at: string;
    reason: string;
    error_name: string;
    error_code?: string;
  }>;
};

export type PersistedEventIngressDeadLetter = {
  code: EventIngressDeadLetterCode;
  reason: string;
  rejectedAt: string;
  path: string;
};

/** 재시도 중인 실패 기록이 있다는 표시. 성공 뒤 지울 때 쓴다. */
export type RetryingEventIngressFailure = {
  state: "retrying";
  path: string;
};

export type EventIngressFailureLookup =
  | PersistedEventIngressDeadLetter
  | RetryingEventIngressFailure;

export function isRetryingFailure(
  lookup: EventIngressFailureLookup,
): lookup is RetryingEventIngressFailure {
  return "state" in lookup && lookup.state === "retrying";
}

export type EventIngressFailureDecision = {
  failureCount: number;
  deadLetter: PersistedEventIngressDeadLetter | null;
};

export type EventIngressDeadLetterListState = "dead_lettered" | "retrying" | "all";

export type EventIngressDeadLetterListInput = {
  state?: EventIngressDeadLetterListState;
  since?: string;
  until?: string;
  nodeId?: string;
  limit?: number;
  cursor?: string;
};

/**
 * dead-letter 파일 하나의 요약. payload, failures[], searchable_text 같은 원문
 * 칸은 일부러 담지 않는다.
 */
export type EventIngressDeadLetterListItem = {
  id: string;
  version: 1 | 2;
  state: "dead_lettered" | "retrying";
  code: EventIngressDeadLetterCode;
  reason: string;
  node_id: string;
  session_id: string;
  stream_id: string;
  source_seq: number;
  event_type: string;
  created_at: string;
  first_failed_at: string | null;
  last_failed_at: string | null;
  rejected_at: string | null;
  failure_count: number | null;
  last_error_name: string | null;
  last_error_code: string | null;
  recorded_at: string;
  delay_ms: number;
};

export type EventIngressDeadLetterListResult = {
  items: EventIngressDeadLetterListItem[];
  next_cursor: string | null;
  total_matched: number;
  counts: { dead_lettered: number; retrying: number };
  unreadable_count: number;
  directory_exists: boolean;
};

export type EventIngressDeadLetterStore = {
  find(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
  }): Promise<EventIngressFailureLookup | null>;
  recordFailure(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
    failure: EventIngressFailureDetail;
    threshold: number;
  }): Promise<EventIngressFailureDecision>;
  /** 재시도 중(retrying) 기록만 지운다. dead_lettered 기록과 없는 기록은 건드리지 않는다. */
  removeRetrying?(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
  }): Promise<void>;
};

export class FileEventIngressDeadLetterStore implements EventIngressDeadLetterStore {
  private operationTail: Promise<void> = Promise.resolve();
  private paused = false;

  async pauseWrites(): Promise<void> { this.paused = true; await this.operationTail; }
  resumeWrites(): void { this.paused = false; }
  private requireWritable(): void {
    if (this.paused) throw Object.assign(new Error("Event failure storage is moving; retry"), { statusCode: 503, code: "HANDOVER_RETRY" });
  }

  constructor(
    private readonly directory: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!directory)
      throw new Error("event ingress dead-letter directory is required");
  }

  /**
   * dead-letter 디렉터리의 *.json을 직접 읽는 읽기 전용 목록. 쓰기 잠금
   * (exclusive)과 handover pause(requireWritable)를 거치지 않으므로
   * pauseWrites() 중에도 읽힌다.
   */
  async list(
    input: EventIngressDeadLetterListInput = {},
  ): Promise<EventIngressDeadLetterListResult> {
    const state = input.state ?? "dead_lettered";
    const limit = input.limit ?? 20;
    const cursor =
      input.cursor === undefined ? null : decodeDeadLetterCursor(input.cursor);
    const since =
      input.since === undefined
        ? null
        : parseDeadLetterTimestamp(input.since, "since");
    const until =
      input.until === undefined
        ? null
        : parseDeadLetterTimestamp(input.until, "until");

    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return {
        items: [],
        next_cursor: null,
        total_matched: 0,
        counts: { dead_lettered: 0, retrying: 0 },
        unreadable_count: 0,
        directory_exists: false,
      };
    }

    let unreadableCount = 0;
    const scoped: EventIngressDeadLetterListItem[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const item = await this.readListEntry(name);
      if (item === null) {
        unreadableCount += 1;
        continue;
      }
      if (input.nodeId !== undefined && item.node_id !== input.nodeId) continue;
      const recordedMs = Date.parse(item.recorded_at);
      if (since !== null && recordedMs < since) continue;
      if (until !== null && recordedMs >= until) continue;
      scoped.push(item);
    }

    const counts = { dead_lettered: 0, retrying: 0 };
    for (const item of scoped) counts[item.state] += 1;

    const matched = scoped
      .filter((item) => state === "all" || item.state === state)
      .sort(compareDeadLetterItems);
    const remaining =
      cursor === null
        ? matched
        : matched.filter((item) => isAfterDeadLetterCursor(item, cursor));
    const page = remaining.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page,
      next_cursor:
        remaining.length > limit && last !== undefined
          ? encodeDeadLetterCursor(last)
          : null,
      total_matched: matched.length,
      counts,
      unreadable_count: unreadableCount,
      directory_exists: true,
    };
  }

  private async readListEntry(
    name: string,
  ): Promise<EventIngressDeadLetterListItem | null> {
    let value: unknown;
    try {
      value = JSON.parse(
        await readFile(join(this.directory, name), "utf8"),
      ) as unknown;
    } catch {
      return null;
    }
    return deadLetterListItem(name.slice(0, -".json".length), value);
  }

  async find(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
  }): Promise<EventIngressFailureLookup | null> {
    this.requireWritable();
    return await this.exclusive(async () => {
      const currentPath = this.recordPath(input.envelope);
      const current = await this.readRecord(currentPath);
      if (current) {
        assertFailureCoordinate(current, input.envelope, currentPath);
        return current.state === "dead_lettered"
          ? persistedDeadLetter(current, currentPath)
          : { state: "retrying", path: currentPath };
      }
      return await this.readLegacyDeadLetter(input);
    });
  }

  async removeRetrying(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
  }): Promise<void> {
    this.requireWritable();
    await this.exclusive(async () => {
      const path = this.recordPath(input.envelope);
      const current = await this.readRecord(path);
      if (!current || current.state !== "retrying") return;
      assertFailureCoordinate(current, input.envelope, path);
      try {
        await unlink(path);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    });
  }

  async recordFailure(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
    failure: EventIngressFailureDetail;
    threshold: number;
  }): Promise<EventIngressFailureDecision> {
    this.requireWritable();
    if (!Number.isSafeInteger(input.threshold) || input.threshold <= 1) {
      throw new Error(
        "event ingress failure threshold must be an integer greater than one",
      );
    }
    return await this.exclusive(async () => {
      const legacy = await this.readLegacyDeadLetter(input);
      if (legacy) return { failureCount: input.threshold, deadLetter: legacy };

      await mkdir(this.directory, { recursive: true });
      const path = this.recordPath(input.envelope);
      const existing = await this.readRecord(path);
      if (existing) {
        assertFailureCoordinate(existing, input.envelope, path);
        if (existing.state === "dead_lettered") {
          return {
            failureCount: existing.failure_count,
            deadLetter: persistedDeadLetter(existing, path),
          };
        }
      }

      const failedAt = this.now().toISOString();
      const failures = [
        ...(existing?.failures ?? []),
        {
          failed_at: failedAt,
          reason: input.failure.reason,
          error_name: input.failure.errorName,
          ...(input.failure.errorCode === undefined
            ? {}
            : { error_code: input.failure.errorCode }),
        },
      ];
      const failureCount = failures.length;
      const deadLettered = failureCount >= input.threshold;
      const record: EventIngressFailureRecord = {
        version: 2,
        state: deadLettered ? "dead_lettered" : "retrying",
        code: EVENT_INGRESS_REPEATED_FAILURE,
        reason: input.failure.reason,
        rejected_at: deadLettered ? failedAt : null,
        node_id: input.nodeId,
        envelope: structuredClone(input.envelope),
        failure_count: failureCount,
        failures,
      };
      await this.writeRecord(path, record);
      return {
        failureCount,
        deadLetter: deadLettered ? persistedDeadLetter(record, path) : null,
      };
    });
  }

  private async readLegacyDeadLetter(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
  }): Promise<PersistedEventIngressDeadLetter | null> {
    const path = this.legacyRecordPath(input.nodeId, input.envelope);
    const record = await this.readUnknown(path);
    if (record === null) return null;
    if (!isLegacyDeadLetterRecord(record)) {
      throw new Error(
        `event ingress legacy dead-letter record is invalid: ${path}`,
      );
    }
    // The legacy path omitted payload_hash. A different hash is a different
    // failure identity under the v2 contract, so it must not inherit the old DLQ.
    if (record.envelope.payload_hash !== input.envelope.payload_hash) return null;
    assertLegacyCoordinate(record, input.nodeId, input.envelope, path);
    return {
      code: record.code,
      reason: record.reason,
      rejectedAt: record.rejected_at,
      path,
    };
  }

  private async readRecord(
    path: string,
  ): Promise<EventIngressFailureRecord | null> {
    const value = await this.readUnknown(path);
    if (value === null) return null;
    if (!isFailureRecord(value)) {
      throw new Error(`event ingress failure record is invalid: ${path}`);
    }
    return value;
  }

  private async readUnknown(path: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  private async writeRecord(
    path: string,
    record: EventIngressFailureRecord,
  ): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    const directoryHandle = await open(this.directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }

  private recordPath(envelope: EventIngressEnvelope): string {
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          envelope.stream_id,
          envelope.source_seq,
          envelope.payload_hash,
        ]),
      )
      .digest("hex");
    return join(this.directory, `${digest}.json`);
  }

  private legacyRecordPath(
    nodeId: string,
    envelope: EventIngressEnvelope,
  ): string {
    const digest = createHash("sha256")
      .update(JSON.stringify([nodeId, envelope.stream_id, envelope.source_seq]))
      .digest("hex");
    return join(this.directory, `${digest}.json`);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function persistedDeadLetter(
  record: EventIngressFailureRecord,
  path: string,
): PersistedEventIngressDeadLetter {
  if (record.rejected_at === null) {
    throw new Error(
      `event ingress dead-letter record has no rejection time: ${path}`,
    );
  }
  return {
    code: record.code,
    reason: record.reason,
    rejectedAt: record.rejected_at,
    path,
  };
}

function assertFailureCoordinate(
  record: Pick<EventIngressFailureRecord, "envelope">,
  envelope: EventIngressEnvelope,
  path: string,
): void {
  if (
    record.envelope.stream_id !== envelope.stream_id ||
    record.envelope.source_seq !== envelope.source_seq ||
    record.envelope.payload_hash !== envelope.payload_hash
  ) {
    throw new Error(
      `event ingress failure coordinate conflicts at source_seq ${envelope.source_seq}: ${path}`,
    );
  }
}

function assertLegacyCoordinate(
  record: Pick<LegacyEventIngressDeadLetterRecord, "node_id" | "envelope">,
  nodeId: string,
  envelope: EventIngressEnvelope,
  path: string,
): void {
  if (
    record.node_id !== nodeId ||
    record.envelope.stream_id !== envelope.stream_id ||
    record.envelope.source_seq !== envelope.source_seq ||
    record.envelope.session_id !== envelope.session_id ||
    record.envelope.payload_hash !== envelope.payload_hash
  ) {
    throw new Error(
      `event ingress dead-letter coordinate conflicts at source_seq ${envelope.source_seq}: ${path}`,
    );
  }
}

function isLegacyDeadLetterRecord(
  value: unknown,
): value is LegacyEventIngressDeadLetterRecord {
  if (!isBaseRecord(value) || value.code !== EVENT_INGRESS_SESSION_NOT_FOUND)
    return false;
  return (
    typeof value.reason === "string" && typeof value.rejected_at === "string"
  );
}

function isFailureRecord(value: unknown): value is EventIngressFailureRecord {
  if (!isBaseRecord(value)) return false;
  return (
    value.version === 2 &&
    (value.state === "retrying" || value.state === "dead_lettered") &&
    value.code === EVENT_INGRESS_REPEATED_FAILURE &&
    typeof value.reason === "string" &&
    (value.rejected_at === null || typeof value.rejected_at === "string") &&
    Number.isSafeInteger(value.failure_count) &&
    Number(value.failure_count) > 0 &&
    Array.isArray(value.failures) &&
    value.failures.length === value.failure_count &&
    value.failures.every(isFailureEntry)
  );
}

function isBaseRecord(
  value: unknown,
): value is Record<string, unknown> &
  Pick<LegacyEventIngressDeadLetterRecord, "node_id" | "envelope"> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.node_id !== "string" ||
    !record.envelope ||
    typeof record.envelope !== "object"
  ) {
    return false;
  }
  const envelope = record.envelope as Record<string, unknown>;
  return (
    typeof envelope.stream_id === "string" &&
    Number.isSafeInteger(envelope.source_seq) &&
    typeof envelope.session_id === "string" &&
    typeof envelope.payload_hash === "string"
  );
}

function isFailureEntry(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.failed_at === "string" &&
    typeof entry.reason === "string" &&
    typeof entry.error_name === "string" &&
    (entry.error_code === undefined || typeof entry.error_code === "string")
  );
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT",
  );
}

function parseDeadLetterTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an ISO-8601 timestamp`);
  }
  return parsed;
}

function encodeDeadLetterCursor(
  item: Pick<EventIngressDeadLetterListItem, "recorded_at" | "id">,
): string {
  return `${item.recorded_at}|${item.id}`;
}

function decodeDeadLetterCursor(cursor: string): {
  recordedMs: number;
  id: string;
} {
  const separator = cursor.lastIndexOf("|");
  if (separator <= 0 || separator === cursor.length - 1) {
    throw new Error("dead-letter cursor is invalid");
  }
  const recordedMs = Date.parse(cursor.slice(0, separator));
  if (!Number.isFinite(recordedMs)) {
    throw new Error("dead-letter cursor is invalid");
  }
  return { recordedMs, id: cursor.slice(separator + 1) };
}

function compareDeadLetterItems(
  left: EventIngressDeadLetterListItem,
  right: EventIngressDeadLetterListItem,
): number {
  const delta = Date.parse(right.recorded_at) - Date.parse(left.recorded_at);
  if (delta !== 0) return delta;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

function isAfterDeadLetterCursor(
  item: EventIngressDeadLetterListItem,
  cursor: { recordedMs: number; id: string },
): boolean {
  const recordedMs = Date.parse(item.recorded_at);
  if (recordedMs !== cursor.recordedMs) return recordedMs < cursor.recordedMs;
  return item.id < cursor.id;
}

function isListableEnvelope(envelope: EventIngressEnvelope): boolean {
  return (
    typeof envelope.stream_id === "string" &&
    Number.isSafeInteger(envelope.source_seq) &&
    typeof envelope.session_id === "string" &&
    typeof envelope.event_type === "string" &&
    typeof envelope.created_at === "string"
  );
}

function deadLetterListItem(
  id: string,
  value: unknown,
): EventIngressDeadLetterListItem | null {
  if (isFailureRecord(value)) {
    const last = value.failures[value.failures.length - 1];
    if (last === undefined || !isListableEnvelope(value.envelope)) return null;
    const recordedAt =
      value.state === "dead_lettered" ? value.rejected_at : last.failed_at;
    if (typeof recordedAt !== "string") return null;
    const recordedMs = Date.parse(recordedAt);
    const createdMs = Date.parse(value.envelope.created_at);
    if (!Number.isFinite(recordedMs) || !Number.isFinite(createdMs)) return null;
    return {
      id,
      version: 2,
      state: value.state,
      code: value.code,
      reason: value.reason.slice(0, 500),
      node_id: value.node_id,
      session_id: value.envelope.session_id,
      stream_id: value.envelope.stream_id,
      source_seq: value.envelope.source_seq,
      event_type: value.envelope.event_type,
      created_at: value.envelope.created_at,
      first_failed_at: value.failures[0]?.failed_at ?? null,
      last_failed_at: last.failed_at,
      rejected_at: value.rejected_at,
      failure_count: value.failure_count,
      last_error_name: last.error_name,
      last_error_code: last.error_code ?? null,
      recorded_at: recordedAt,
      delay_ms: recordedMs - createdMs,
    };
  }
  if (isLegacyDeadLetterRecord(value)) {
    if (!isListableEnvelope(value.envelope)) return null;
    const recordedMs = Date.parse(value.rejected_at);
    const createdMs = Date.parse(value.envelope.created_at);
    if (!Number.isFinite(recordedMs) || !Number.isFinite(createdMs)) return null;
    return {
      id,
      version: 1,
      state: "dead_lettered",
      code: value.code,
      reason: value.reason.slice(0, 500),
      node_id: value.node_id,
      session_id: value.envelope.session_id,
      stream_id: value.envelope.stream_id,
      source_seq: value.envelope.source_seq,
      event_type: value.envelope.event_type,
      created_at: value.envelope.created_at,
      first_failed_at: null,
      last_failed_at: null,
      rejected_at: value.rejected_at,
      failure_count: null,
      last_error_name: null,
      last_error_code: null,
      recorded_at: value.rejected_at,
      delay_ms: recordedMs - createdMs,
    };
  }
  return null;
}
