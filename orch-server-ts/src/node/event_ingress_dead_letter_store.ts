import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
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

export type EventIngressFailureDecision = {
  failureCount: number;
  deadLetter: PersistedEventIngressDeadLetter | null;
};

export type EventIngressDeadLetterStore = {
  find(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
  }): Promise<PersistedEventIngressDeadLetter | null>;
  recordFailure(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
    failure: EventIngressFailureDetail;
    threshold: number;
  }): Promise<EventIngressFailureDecision>;
};

export class FileEventIngressDeadLetterStore implements EventIngressDeadLetterStore {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!directory)
      throw new Error("event ingress dead-letter directory is required");
  }

  async find(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
  }): Promise<PersistedEventIngressDeadLetter | null> {
    return await this.exclusive(async () => {
      const currentPath = this.recordPath(input.envelope);
      const current = await this.readRecord(currentPath);
      if (current) {
        assertFailureCoordinate(current, input.envelope, currentPath);
        return current.state === "dead_lettered"
          ? persistedDeadLetter(current, currentPath)
          : null;
      }
      return await this.readLegacyDeadLetter(input);
    });
  }

  async recordFailure(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
    failure: EventIngressFailureDetail;
    threshold: number;
  }): Promise<EventIngressFailureDecision> {
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
