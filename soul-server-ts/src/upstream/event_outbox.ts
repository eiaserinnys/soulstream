import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  truncate,
} from "node:fs/promises";
import { join } from "node:path";

import { renameWithTransientRetry } from "../atomic_file_rename.js";
import { advanceUnacknowledgedSourceSequence } from "../event_outbox_recovery.js";
import {
  appendEventOutboxQuarantine,
  type EventOutboxQuarantineInput,
  type EventOutboxQuarantineResult,
} from "./event_outbox_quarantine.js";

export const EVENT_OUTBOX_MAX_BATCH_EVENTS = 64;
export const EVENT_OUTBOX_MAX_BATCH_BYTES = 256 * 1024;
export const EVENT_OUTBOX_MAX_SINGLE_EVENT_BYTES = 2 * 1024 * 1024;
export const EVENT_OUTBOX_COMPACT_ROWS = 1_000;
export const EVENT_OUTBOX_COMPACT_BYTES = 8 * 1024 * 1024;
export const EVENT_OUTBOX_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;

export type SessionLastMessage = {
  type: string;
  preview: string;
  timestamp: string;
};

export type EventOutboxSessionEffect =
  | {
      kind: "last_message";
      last_message: SessionLastMessage;
      updated_at: string;
    }
  | {
      kind: "set_backend_session_id";
      backend_session_id: string;
    }
  | {
      kind: "rotate_backend_session_id";
      expected_backend_session_id: string;
      backend_session_id: string;
    }
  | {
      kind: "running_transition";
      review_state: string;
      expected_terminal_event_id?: number | null;
      updated_at: string;
    }
  | {
      kind: "terminal_transition";
      status: string;
      termination_reason: string;
      termination_detail: string | null;
      review_state: string;
      last_assistant_text?: string | null;
      updated_at: string;
    }
  | {
      kind: "append_metadata";
      entry: Record<string, unknown>;
      updated_at: string;
      replace_existing_type?: string;
    };

export type EventOutboxRecord = {
  stream_id: string;
  source_seq: number;
  session_id: string;
  event_type: string;
  payload: unknown;
  searchable_text: string | null;
  created_at: string;
  semantic_dedupe_key: string | null;
  session_effect: EventOutboxSessionEffect | null;
  payload_hash: string;
};

export type EventOutboxAppendInput = Omit<
  EventOutboxRecord,
  "stream_id" | "source_seq" | "payload_hash"
>;

export type EventOutboxBatch = {
  type: "event_append_batch";
  protocol_version: 1;
  stream_id: string;
  first_seq: number;
  events: [EventOutboxRecord, ...EventOutboxRecord[]];
};

type EventOutboxMetadata = {
  stream_id: string;
  next_seq: number;
  acked_seq: number;
};

export class EventOutbox {
  private readonly metadataPath: string;
  private readonly eventsPath: string;
  private metadata!: EventOutboxMetadata;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly appendListeners = new Set<() => void>();

  private constructor(private readonly directory: string) {
    this.metadataPath = join(directory, "metadata.json");
    this.eventsPath = join(directory, "events.jsonl");
  }

  static async open(directory: string): Promise<EventOutbox> {
    if (!directory) throw new Error("EVENT_OUTBOX_DIR required");
    const outbox = new EventOutbox(directory);
    await outbox.initialize();
    return outbox;
  }

  get streamId(): string {
    return this.metadata.stream_id;
  }

  get ackedSeq(): number {
    return this.metadata.acked_seq;
  }

  onAppend(listener: () => void): () => void {
    this.appendListeners.add(listener);
    return () => this.appendListeners.delete(listener);
  }

  async append(input: EventOutboxAppendInput): Promise<EventOutboxRecord> {
    return await this.exclusive(async () => {
      validateAppendInput(input);
      const unsigned = {
        stream_id: this.metadata.stream_id,
        source_seq: this.metadata.next_seq,
        ...input,
      };
      const record: EventOutboxRecord = {
        ...unsigned,
        payload_hash: computeEventOutboxPayloadHash(unsigned),
      };
      assertSingleRecordFits(record);

      const handle = await open(this.eventsPath, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.datasync();
      } finally {
        await handle.close();
      }

      this.metadata = { ...this.metadata, next_seq: record.source_seq + 1 };
      await this.persistMetadata();
      for (const listener of this.appendListeners) listener();
      return record;
    });
  }

  async readBatch(maxEvents = EVENT_OUTBOX_MAX_BATCH_EVENTS): Promise<EventOutboxBatch | null> {
    return await this.exclusive(async () => {
      assertBatchEventLimit(maxEvents);
      const pending = (await this.readRecords()).filter(
        (record) => record.source_seq > this.metadata.acked_seq,
      );
      if (pending.length === 0) return null;
      const selected: EventOutboxRecord[] = [];
      for (const record of pending) {
        if (selected.length >= maxEvents) break;
        const candidateArray = [...selected, record];
        const candidate: [EventOutboxRecord, ...EventOutboxRecord[]] = [
          candidateArray[0]!,
          ...candidateArray.slice(1),
        ];
        const frame = buildBatch(this.metadata.stream_id, candidate);
        const frameBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
        if (frameBytes > EVENT_OUTBOX_MAX_BATCH_BYTES) {
          if (
            selected.length === 0
            && frameBytes <= EVENT_OUTBOX_MAX_SINGLE_EVENT_BYTES
          ) {
            selected.push(record);
          }
          break;
        }
        selected.push(record);
      }
      if (selected.length === 0) {
        throw new Error("event outbox record exceeds 2 MiB single-event contract");
      }
      return buildBatch(
        this.metadata.stream_id,
        selected as [EventOutboxRecord, ...EventOutboxRecord[]],
      );
    });
  }

  async acknowledge(streamId: string, ackedThrough: number): Promise<void> {
    await this.exclusive(async () => {
      if (streamId !== this.metadata.stream_id) {
        throw new Error("event outbox ACK stream_id mismatch");
      }
      if (!Number.isSafeInteger(ackedThrough) || ackedThrough <= 0) {
        throw new Error("event outbox ACK cursor must be a positive integer");
      }
      if (ackedThrough <= this.metadata.acked_seq) return;
      if (ackedThrough >= this.metadata.next_seq) {
        throw new Error("event outbox ACK exceeds durable append cursor");
      }
      this.metadata = { ...this.metadata, acked_seq: ackedThrough };
      await this.persistMetadata();
      await this.compactIfNeeded();
    });
  }

  async quarantineHead(
    input: EventOutboxQuarantineInput,
  ): Promise<EventOutboxQuarantineResult> {
    return await this.exclusive(async () => {
      if (input.record.stream_id !== this.metadata.stream_id) {
        throw new Error("event outbox quarantine stream_id mismatch");
      }
      const expectedHead = this.metadata.acked_seq + 1;
      if (input.record.source_seq !== expectedHead) {
        throw new Error("event outbox quarantine target is not the durable head");
      }
      const durable = (await this.readRecords()).find(
        (record) => record.source_seq === expectedHead,
      );
      if (!durable || durable.payload_hash !== input.record.payload_hash) {
        throw new Error("event outbox quarantine target differs from durable head");
      }
      const result = await appendEventOutboxQuarantine(this.directory, input);
      this.metadata = { ...this.metadata, acked_seq: expectedHead };
      await this.persistMetadata();
      await this.compactIfNeeded();
      return result;
    });
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.truncateIncompleteTail();
    this.metadata = await this.loadMetadata();
    const records = await this.readRecords();
    validateRecoveredRecords(records, this.metadata);
    const lastSeq = records.at(-1)?.source_seq ?? this.metadata.acked_seq;
    const reconciledNextSeq = Math.max(
      this.metadata.next_seq,
      this.metadata.acked_seq + 1,
      lastSeq + 1,
    );
    if (reconciledNextSeq !== this.metadata.next_seq) {
      this.metadata = { ...this.metadata, next_seq: reconciledNextSeq };
      await this.persistMetadata();
    }
  }

  private async loadMetadata(): Promise<EventOutboxMetadata> {
    try {
      const parsed = JSON.parse(await readFile(this.metadataPath, "utf8")) as unknown;
      if (!isMetadata(parsed)) throw new Error("event outbox metadata is invalid");
      return parsed;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const metadata = { stream_id: randomUUID(), next_seq: 1, acked_seq: 0 };
      this.metadata = metadata;
      await this.persistMetadata();
      return metadata;
    }
  }

  private async persistMetadata(): Promise<void> {
    const temporaryPath = `${this.metadataPath}.tmp`;
    const handle = await open(temporaryPath, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(this.metadata)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithTransientRetry(temporaryPath, this.metadataPath, {
      retryDelaysMs: EVENT_OUTBOX_RENAME_RETRY_DELAYS_MS,
    });
  }

  private async truncateIncompleteTail(): Promise<void> {
    let contents: Buffer;
    try {
      contents = await readFile(this.eventsPath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const handle = await open(this.eventsPath, "a", 0o600);
      await handle.close();
      return;
    }
    if (contents.length === 0 || contents.at(-1) === 0x0a) return;
    const lastNewline = contents.lastIndexOf(0x0a);
    await truncate(this.eventsPath, lastNewline + 1);
  }

  private async readRecords(): Promise<EventOutboxRecord[]> {
    const text = await readFile(this.eventsPath, "utf8");
    if (!text) return [];
    return text.split("\n").filter(Boolean).map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`event outbox has invalid complete JSONL row ${index + 1}`, { cause: error });
      }
      if (!isOutboxRecord(parsed)) {
        throw new Error(`event outbox has invalid record at row ${index + 1}`);
      }
      return parsed;
    });
  }

  private async compactIfNeeded(): Promise<void> {
    const records = await this.readRecords();
    const acknowledged = records.filter(
      (record) => record.source_seq <= this.metadata.acked_seq,
    );
    const acknowledgedBytes = acknowledged.reduce(
      (total, record) => total + Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8"),
      0,
    );
    if (
      acknowledged.length < EVENT_OUTBOX_COMPACT_ROWS
      && acknowledgedBytes < EVENT_OUTBOX_COMPACT_BYTES
    ) return;

    const remaining = records.filter(
      (record) => record.source_seq > this.metadata.acked_seq,
    );
    const temporaryPath = `${this.eventsPath}.tmp`;
    const handle = await open(temporaryPath, "w", 0o600);
    try {
      await handle.writeFile(
        remaining.map((record) => `${JSON.stringify(record)}\n`).join(""),
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithTransientRetry(temporaryPath, this.eventsPath, {
      retryDelaysMs: EVENT_OUTBOX_RENAME_RETRY_DELAYS_MS,
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return await result;
  }
}

function assertBatchEventLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > EVENT_OUTBOX_MAX_BATCH_EVENTS) {
    throw new Error(`event outbox batch event limit must be 1-${EVENT_OUTBOX_MAX_BATCH_EVENTS}`);
  }
}

function buildBatch(
  streamId: string,
  events: [EventOutboxRecord, ...EventOutboxRecord[]],
): EventOutboxBatch {
  return {
    type: "event_append_batch",
    protocol_version: 1,
    stream_id: streamId,
    first_seq: events[0].source_seq,
    events,
  };
}

export function computeEventOutboxPayloadHash(
  record: Omit<EventOutboxRecord, "payload_hash">,
): string {
  const canonical = {
    stream_id: record.stream_id,
    source_seq: record.source_seq,
    session_id: record.session_id,
    event_type: record.event_type,
    payload: record.payload,
    searchable_text: record.searchable_text,
    created_at: record.created_at,
    semantic_dedupe_key: record.semantic_dedupe_key,
    session_effect: record.session_effect,
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function assertSingleRecordFits(record: EventOutboxRecord): void {
  const frame = buildBatch(record.stream_id, [record]);
  if (
    Buffer.byteLength(JSON.stringify(frame), "utf8")
    > EVENT_OUTBOX_MAX_SINGLE_EVENT_BYTES
  ) {
    throw new Error("event payload exceeds 2 MiB ingress single-event contract");
  }
}

function validateAppendInput(input: EventOutboxAppendInput): void {
  if (!input.session_id || !input.event_type) throw new Error("event outbox session and type required");
  if (!Number.isFinite(Date.parse(input.created_at))) throw new Error("event outbox created_at invalid");
  if (JSON.stringify(input.payload) === undefined) {
    throw new Error("event outbox payload must be JSON serializable");
  }
}

function validateRecoveredRecords(
  records: EventOutboxRecord[],
  metadata: EventOutboxMetadata,
): void {
  let previousUnacknowledged = metadata.acked_seq;
  for (const record of records) {
    if (record.stream_id !== metadata.stream_id) {
      throw new Error("event outbox record stream mismatch");
    }
    const { payload_hash: payloadHash, ...unsigned } = record;
    if (computeEventOutboxPayloadHash(unsigned) !== payloadHash) {
      throw new Error(`event outbox payload hash mismatch at source_seq ${record.source_seq}`);
    }
    previousUnacknowledged = advanceUnacknowledgedSourceSequence(
      record.source_seq,
      metadata.acked_seq,
      previousUnacknowledged,
    );
  }
  const lastSeq = records.at(-1)?.source_seq;
  if (
    metadata.next_seq > metadata.acked_seq + 1
    && (lastSeq === undefined || lastSeq < metadata.next_seq - 1)
  ) {
    throw new Error("event outbox metadata is ahead of durable JSONL records");
  }
}

function isMetadata(value: unknown): value is EventOutboxMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.stream_id === "string"
    && Number.isSafeInteger(item.next_seq) && (item.next_seq as number) > 0
    && Number.isSafeInteger(item.acked_seq) && (item.acked_seq as number) >= 0
    && (item.acked_seq as number) < (item.next_seq as number);
}

function isOutboxRecord(value: unknown): value is EventOutboxRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.stream_id === "string"
    && Number.isSafeInteger(item.source_seq) && (item.source_seq as number) > 0
    && typeof item.session_id === "string" && item.session_id.length > 0
    && typeof item.event_type === "string" && item.event_type.length > 0
    && typeof item.created_at === "string"
    && typeof item.payload_hash === "string" && /^[0-9a-f]{64}$/.test(item.payload_hash);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
