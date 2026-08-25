import type { SessionMessage, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vitest";

import {
  ClaudeDeliveryTranscriptReceiptReader,
  findClaudeDeliveryTranscriptReceipt,
} from "../../src/engine/claude_delivery_transcript_receipt.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import { buildDeliveryInputUuid } from "../../src/task/delivery_identity.js";
import { buildCanonicalDeliveryPayload } from "../../src/task/delivery_payload.js";
import { TaskDeliveryTurnReceipt } from
  "../../src/task/task_delivery_turn_receipt.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";

type AttemptKind = "metadata_then_error" | "accepted_complete";
type DeliveryState = "queued" | "delivered" | "consumed";
type JournalKind =
  | "assistant"
  | "complete"
  | "consume"
  | "metadata"
  | "model_input"
  | "recovery_attempt"
  | "recovery_injection"
  | "result"
  | "stream_closed"
  | "turn";

interface JournalEntry {
  kind: JournalKind;
  deliveryId: string;
  attempt: number;
  inputUuid?: string;
  payloadHash?: string;
  prompt?: string;
  proofAtConsume?: boolean;
}

interface DeliveryRow {
  deliveryId: string;
  payloadHash: string;
  state: DeliveryState;
  consumedAt: string | null;
}

export type C2OracleMutation =
  | "promote_metadata_to_proof"
  | "hide_input_proof_omission"
  | "hide_second_consume_replay";

export class HumanLiveSteerModelInputHarness {
  readonly deliveryId: string;
  readonly message: InterventionMessage;
  readonly row: DeliveryRow;
  readonly journal: JournalEntry[] = [];
  readonly transcript: SessionMessage[] = [];
  readonly recordConsumed = vi.fn(async (
    _message: InterventionMessage,
    _task: Task,
    _receiptId?: string,
  ) => {
    const attempt = this.currentAttempt;
    const proofAtConsume = this.hasRawAuthoritativeInputProof();
    this.journal.push({
      kind: "consume",
      deliveryId: this.deliveryId,
      attempt,
      proofAtConsume,
    });
    this.row.state = "consumed";
    this.row.consumedAt = "2026-08-25T00:01:00.000Z";
  });
  readonly recordTurnStarted = vi.fn(async () => {
    if (this.row.state !== "consumed") this.row.state = "delivered";
    return true;
  });

  private currentAttempt = 0;
  private claimedAcceptanceWithoutTranscript = false;
  private readonly transcriptReceipt: Pick<
    ClaudeDeliveryTranscriptReceiptReader,
    "inspect"
  >;

  constructor(deliveryId: string) {
    this.deliveryId = deliveryId;
    const text = `human-live-steer:${deliveryId}`;
    const canonical = buildCanonicalDeliveryPayload({
      text,
      user: "agent",
      source: "user_message",
      completionId: `message:${deliveryId}`,
      relationKey: `user_message:c2:${deliveryId}`,
    });
    this.message = {
      text,
      user: "agent",
      source: "user_message",
      deliveryId,
      deliveryIntent: "human_live_steer",
      completionId: `message:${deliveryId}`,
      relationKey: `user_message:c2:${deliveryId}`,
      storedDeliveryPayload: canonical.payload,
      storedDeliveryPayloadHash: canonical.payloadHash,
    };
    this.row = {
      deliveryId,
      payloadHash: canonical.payloadHash,
      state: "queued",
      consumedAt: null,
    };
    this.transcriptReceipt = new ClaudeDeliveryTranscriptReceiptReader({
      sourceNode: "eiaserinnys",
      sessionStore: {} as SessionStore,
      getSession: async () => ({
        agent_id: "claude-roselin",
        claude_session_id: "claude-session-c2",
        model_preset: "claude-opus",
        node_id: "eiaserinnys",
      }) as never,
      getAgent: () => ({
        backend: "claude",
        workspace_dir: "/work",
      }) as never,
      getModelPresetBackend: () => "claude",
      loadMessages: async () => this.transcript,
    });
  }

  async execute(kind: AttemptKind): Promise<void> {
    this.currentAttempt += 1;
    const attempt = this.currentAttempt;
    const task = this.makeTask(attempt);
    const receipt = new TaskDeliveryTurnReceipt(
      {
        recordTurnStarted: this.recordTurnStarted,
        recordConsumed: this.recordConsumed,
      },
      this.message,
      this.transcriptReceipt,
      true,
      `event:${task.lastEventId ?? "unknown"}`,
    );
    this.journal.push({
      kind: "turn",
      deliveryId: this.deliveryId,
      attempt,
    });
    try {
      if (kind === "accepted_complete") {
        this.acceptModelInput(this.message.text, attempt);
      }
      this.journal.push({
        kind: "metadata",
        deliveryId: this.deliveryId,
        attempt,
      });
      await receipt.observe(task, {
        type: "metadata",
        metadata_type: "execution_ownership_transition",
        value: { phase: "execution_activate" },
      } as unknown as SSEEventPayload);
      if (kind === "metadata_then_error") {
        throw new Error("runner closed before authoritative model input proof");
      }

      this.appendAssistantTranscript(attempt);
      this.journal.push({
        kind: "assistant",
        deliveryId: this.deliveryId,
        attempt,
      });
      await receipt.observe(task, {
        type: "assistant_message",
        content: `handled:${this.deliveryId}`,
        timestamp: attempt,
      } as SSEEventPayload);
      this.journal.push({
        kind: "result",
        deliveryId: this.deliveryId,
        attempt,
      });
      await receipt.observe(task, {
        type: "result",
        result: "done",
        timestamp: attempt,
      } as unknown as SSEEventPayload);
      this.journal.push({
        kind: "complete",
        deliveryId: this.deliveryId,
        attempt,
      });
      await receipt.observe(task, {
        type: "complete",
        result: "done",
        timestamp: attempt,
      } as SSEEventPayload);
    } catch (error) {
      if (
        !(error instanceof Error)
        || error.message !== "runner closed before authoritative model input proof"
      ) {
        throw error;
      }
    } finally {
      await receipt.consume(task);
      this.journal.push({
        kind: "stream_closed",
        deliveryId: this.deliveryId,
        attempt,
      });
    }
  }

  async recoverOnce(): Promise<boolean> {
    this.journal.push({
      kind: "recovery_attempt",
      deliveryId: this.deliveryId,
      attempt: this.currentAttempt + 1,
    });
    if (this.row.state === "consumed") return false;
    this.journal.push({
      kind: "recovery_injection",
      deliveryId: this.deliveryId,
      attempt: this.currentAttempt + 1,
    });
    await this.execute("accepted_complete");
    return true;
  }

  async replayMetadataAndRecoverOnce(): Promise<boolean> {
    this.journal.push({
      kind: "metadata",
      deliveryId: this.deliveryId,
      attempt: this.currentAttempt + 1,
    });
    return this.recoverOnce();
  }

  hasRawAuthoritativeInputProof(): boolean {
    const inputUuid = buildDeliveryInputUuid(this.deliveryId);
    const receipt = findClaudeDeliveryTranscriptReceipt(this.transcript, inputUuid);
    const matchingInput = this.journal.some(
      (entry) => entry.kind === "model_input"
        && entry.deliveryId === this.deliveryId
        && entry.inputUuid === inputUuid
        && entry.payloadHash === this.row.payloadHash
        && entry.prompt === this.message.text,
    );
    return receipt.kind !== "absent" && matchingInput;
  }

  visibleAuthoritativeInputProofCount(): number {
    const mutation = currentMutation();
    if (
      mutation === "promote_metadata_to_proof"
      && this.rawCount("metadata") > 0
    ) {
      return 1;
    }
    if (
      mutation === "hide_input_proof_omission"
      && this.claimedAcceptanceWithoutTranscript
    ) {
      return 1;
    }
    return this.hasRawAuthoritativeInputProof() ? 1 : 0;
  }

  visibleCount(kind: Extract<JournalKind, "consume" | "recovery_attempt">): number {
    const matching = this.journal.filter((entry) => entry.kind === kind);
    if (currentMutation() !== "hide_second_consume_replay") return matching.length;
    return new Set(matching.map((entry) => entry.deliveryId)).size;
  }

  rawCount(kind: JournalKind): number {
    return this.journal.filter((entry) => entry.kind === kind).length;
  }

  consumeBeforeProofCount(): number {
    return this.journal.filter(
      (entry) => entry.kind === "consume" && entry.proofAtConsume === false,
    ).length;
  }

  claimAcceptanceWithoutTranscriptForOracleAudit(): void {
    this.claimedAcceptanceWithoutTranscript = true;
  }

  appendDuplicateConsumeAndReplayForOracleAudit(): void {
    for (const attempt of [1, 2]) {
      this.journal.push({
        kind: "consume",
        deliveryId: this.deliveryId,
        attempt,
        proofAtConsume: true,
      });
      this.journal.push({
        kind: "recovery_attempt",
        deliveryId: this.deliveryId,
        attempt,
      });
    }
  }

  private makeTask(attempt: number): Task {
    return {
      agentSessionId: `c2-session-${attempt}`,
      prompt: "existing foreground turn",
      status: "running",
      profileId: "claude-roselin",
      createdAt: new Date("2026-08-25T00:00:00.000Z"),
      lastEventId: 0,
      lastReadEventId: 0,
      interventionQueue: [{ ...this.message }],
    };
  }

  private acceptModelInput(prompt: string, attempt: number): void {
    if (prompt !== this.message.text) {
      throw new Error(
        `delivery payload identity mismatch: expected ${this.message.text}, got ${prompt}`,
      );
    }
    this.transcript.push(sessionMessage("user", buildDeliveryInputUuid(this.deliveryId)));
    this.journal.push({
      kind: "model_input",
      deliveryId: this.deliveryId,
      attempt,
      inputUuid: buildDeliveryInputUuid(this.deliveryId),
      payloadHash: this.row.payloadHash,
      prompt,
    });
  }

  private appendAssistantTranscript(attempt: number): void {
    this.transcript.push(sessionMessage("assistant", `assistant:c2:${attempt}`));
  }
}

function sessionMessage(
  type: "user" | "assistant",
  uuid: string,
): SessionMessage {
  return {
    type,
    uuid,
    session_id: "claude-session-c2",
    message: {},
    parent_tool_use_id: null,
    parent_agent_id: null,
  };
}

function currentMutation(): C2OracleMutation | null {
  const value = process.env.SOULSTREAM_C2_ORACLE_MUTATION;
  if (
    value === "promote_metadata_to_proof"
    || value === "hide_input_proof_omission"
    || value === "hide_second_consume_replay"
  ) {
    return value;
  }
  return null;
}
