import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import type { EventIngressEnvelope } from "./event_ingress_types.js";

export const EVENT_INGRESS_SESSION_NOT_FOUND = "SESSION_NOT_FOUND" as const;

export type EventIngressDeadLetterRecord = {
  code: typeof EVENT_INGRESS_SESSION_NOT_FOUND;
  reason: string;
  rejected_at: string;
  node_id: string;
  envelope: EventIngressEnvelope;
};

export type PersistedEventIngressDeadLetter = {
  code: typeof EVENT_INGRESS_SESSION_NOT_FOUND;
  reason: string;
  rejectedAt: string;
  path: string;
};

export type EventIngressDeadLetterStore = {
  find(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
  }): Promise<PersistedEventIngressDeadLetter | null>;
  persist(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
    code: typeof EVENT_INGRESS_SESSION_NOT_FOUND;
    reason: string;
  }): Promise<PersistedEventIngressDeadLetter>;
};

export class FileEventIngressDeadLetterStore implements EventIngressDeadLetterStore {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!directory) throw new Error("event ingress dead-letter directory is required");
  }

  async find(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
  }): Promise<PersistedEventIngressDeadLetter | null> {
    return await this.exclusive(async () => await this.readExisting(input));
  }

  async persist(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
    code: typeof EVENT_INGRESS_SESSION_NOT_FOUND;
    reason: string;
  }): Promise<PersistedEventIngressDeadLetter> {
    return await this.exclusive(async () => {
      const existing = await this.readExisting(input);
      if (existing) return existing;

      await mkdir(this.directory, { recursive: true });
      const path = this.recordPath(input.nodeId, input.envelope);
      const rejectedAt = this.now().toISOString();
      const record: EventIngressDeadLetterRecord = {
        code: input.code,
        reason: input.reason,
        rejected_at: rejectedAt,
        node_id: input.nodeId,
        envelope: structuredClone(input.envelope),
      };
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
      return { code: record.code, reason: record.reason, rejectedAt, path };
    });
  }

  private async readExisting(input: {
    nodeId: string;
    envelope: EventIngressEnvelope;
  }): Promise<PersistedEventIngressDeadLetter | null> {
    const path = this.recordPath(input.nodeId, input.envelope);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
    const record = JSON.parse(text) as unknown;
    if (!isDeadLetterRecord(record)) {
      throw new Error(`event ingress dead-letter record is invalid: ${path}`);
    }
    if (
      record.node_id !== input.nodeId
      || record.envelope.stream_id !== input.envelope.stream_id
      || record.envelope.source_seq !== input.envelope.source_seq
      || record.envelope.session_id !== input.envelope.session_id
      || record.envelope.payload_hash !== input.envelope.payload_hash
    ) {
      throw new Error(
        `event ingress dead-letter coordinate conflicts at source_seq ${input.envelope.source_seq}`,
      );
    }
    return {
      code: record.code,
      reason: record.reason,
      rejectedAt: record.rejected_at,
      path,
    };
  }

  private recordPath(nodeId: string, envelope: EventIngressEnvelope): string {
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

function isDeadLetterRecord(value: unknown): value is EventIngressDeadLetterRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    record.code !== EVENT_INGRESS_SESSION_NOT_FOUND
    || typeof record.reason !== "string"
    || typeof record.rejected_at !== "string"
    || typeof record.node_id !== "string"
    || !record.envelope
    || typeof record.envelope !== "object"
  ) return false;
  const envelope = record.envelope as Record<string, unknown>;
  return typeof envelope.stream_id === "string"
    && Number.isSafeInteger(envelope.source_seq)
    && typeof envelope.session_id === "string"
    && typeof envelope.payload_hash === "string";
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && (error as { code?: string }).code === "ENOENT");
}
