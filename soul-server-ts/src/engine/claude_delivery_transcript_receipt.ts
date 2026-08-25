import {
  getSessionMessages,
  type SessionMessage,
  type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";

import type { AgentProfile } from "../agent_registry.js";
import type { SessionDeliveryRow, SessionRow } from "../db/session_db_types.js";
import { buildDeliveryInputUuid } from "../task/delivery_identity.js";

export type ClaudeDeliveryTranscriptReceipt =
  | { kind: "absent"; inputUuid: string }
  | { kind: "input_pending"; inputUuid: string }
  | {
      kind: "completed";
      inputUuid: string;
      assistantMessageUuid: string;
    }
  | { kind: "unavailable"; inputUuid: string; reason: string };

export interface ClaudeDeliveryTranscriptReceiptDeps {
  sourceNode: string;
  sessionStore: SessionStore;
  getSession(sessionId: string): Promise<SessionRow | null>;
  getAgent(agentId: string): AgentProfile | undefined;
  getModelPresetBackend?(
    presetId: string,
  ): AgentProfile["backend"] | undefined;
  loadMessages?: typeof getSessionMessages;
}

/**
 * Reads the Claude receiver's durable transcript before a queued SDK input is
 * replayed after a worker crash.
 *
 * The shared SessionStore is checked first. A same-node restart may also read
 * the CLI JSONL because the Claude subprocess can finish writing after the
 * parent worker dies, before its final mirror batch reaches PostgreSQL.
 */
export class ClaudeDeliveryTranscriptReceiptReader {
  private readonly loadMessages: typeof getSessionMessages;

  constructor(private readonly deps: ClaudeDeliveryTranscriptReceiptDeps) {
    this.loadMessages = deps.loadMessages ?? getSessionMessages;
  }

  async inspect(
    delivery: Pick<SessionDeliveryRow, "delivery_id" | "target_session_id">,
  ): Promise<ClaudeDeliveryTranscriptReceipt> {
    const inputUuid = buildDeliveryInputUuid(delivery.delivery_id);
    const targetSessionId = delivery.target_session_id;
    if (!targetSessionId) return { kind: "absent", inputUuid };
    const session = await this.deps.getSession(targetSessionId);
    if (!session || !session.claude_session_id) {
      return { kind: "absent", inputUuid };
    }
    const agentId = session.agent_id;
    const profile = agentId ? this.deps.getAgent(agentId) : undefined;
    if (!profile) {
      return {
        kind: "unavailable",
        inputUuid,
        reason: "target_agent_profile_unavailable",
      };
    }
    const backend = session.model_preset
      ? this.deps.getModelPresetBackend?.(session.model_preset)
      : profile.backend;
    if (!backend) {
      return {
        kind: "unavailable",
        inputUuid,
        reason: "target_model_preset_unavailable",
      };
    }
    if (backend !== "claude") {
      return { kind: "absent", inputUuid };
    }

    const shared = await this.loadMessages(session.claude_session_id, {
      dir: profile.workspace_dir,
      sessionStore: this.deps.sessionStore,
    });
    const sharedReceipt = findClaudeDeliveryTranscriptReceipt(shared, inputUuid);
    if (sharedReceipt.kind !== "absent") return sharedReceipt;

    if (session.node_id === this.deps.sourceNode) {
      const local = await this.loadMessages(session.claude_session_id, {
        dir: profile.workspace_dir,
      });
      return findClaudeDeliveryTranscriptReceipt(local, inputUuid);
    }
    return {
      kind: "unavailable",
      inputUuid,
      reason: "remote_transcript_not_mirrored",
    };
  }
}

export function findClaudeDeliveryTranscriptReceipt(
  messages: SessionMessage[],
  inputUuid: string,
): ClaudeDeliveryTranscriptReceipt {
  const inputIndex = messages.findIndex(
    (message) => message.type === "user" && message.uuid === inputUuid,
  );
  if (inputIndex < 0) return { kind: "absent", inputUuid };
  const assistant = messages
    .slice(inputIndex + 1)
    .find((message) => message.type === "assistant");
  return assistant
    ? {
        kind: "completed",
        inputUuid,
        assistantMessageUuid: assistant.uuid,
      }
    : { kind: "input_pending", inputUuid };
}
