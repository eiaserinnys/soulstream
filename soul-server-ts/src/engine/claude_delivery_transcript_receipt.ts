import {
  getSessionMessages,
  type SessionMessage,
  type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";

import type { AgentProfile } from "../agent_registry.js";
import type { SessionDeliveryRow, SessionRow } from "../db/session_db_types.js";
import { buildDeliveryInputUuid } from "../task/delivery_identity.js";
import { parseClaudeNativeTaskNotification } from
  "../task/claude_native_task_notification.js";
import { userMessageText } from "./claude_sdk_event_mapper_helpers.js";
import { isTurnStartingUserInput } from
  "./claude_sdk_persistent_session_support.js";

export type ClaudeDeliveryTranscriptReceipt =
  | { kind: "absent"; inputUuid: string }
  | { kind: "input_pending"; inputUuid: string }
  | {
      kind: "completed";
      inputUuid: string;
      assistantMessageUuid: string;
    }
  | { kind: "unavailable"; inputUuid: string; reason: string };

export interface ClaudeNativeTaskNotificationTranscriptQuery {
  taskId: string;
  initiatingToolUseId: string;
  expectedAssistantUuid: string;
}

export interface ClaudeNativeTaskNotificationTranscriptProof {
  kind: "completed";
  inputUuid: string;
  assistantMessageUuid: string;
}

type ClaudeTranscriptTarget =
  | { kind: "ready"; session: SessionRow; profile: AgentProfile }
  | { kind: "absent" }
  | { kind: "unavailable"; reason: string };

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
    delivery: SessionDeliveryRow,
  ): Promise<ClaudeDeliveryTranscriptReceipt> {
    const inputUuid = buildDeliveryInputUuid(delivery.delivery_id);
    return await this.inspectTarget(delivery.target_session_id, inputUuid, false);
  }

  async inspectInput(
    targetSessionId: string,
    inputUuid: string,
    expectedAssistantUuid: string,
  ): Promise<ClaudeDeliveryTranscriptReceipt> {
    return await this.inspectTarget(
      targetSessionId,
      inputUuid,
      true,
      expectedAssistantUuid,
    );
  }

  async inspectNativeTaskNotification(
    targetSessionId: string,
    query: ClaudeNativeTaskNotificationTranscriptQuery,
  ): Promise<ClaudeNativeTaskNotificationTranscriptProof | null> {
    const target = await this.resolveTarget(targetSessionId);
    if (target.kind !== "ready") return null;
    const shared = await this.loadMessages(target.session.claude_session_id!, {
      dir: target.profile.workspace_dir,
      sessionStore: this.deps.sessionStore,
    });
    const sharedProof = findNativeTaskNotificationProof(shared, query);
    if (sharedProof) return sharedProof;
    if (target.session.node_id !== this.deps.sourceNode) return null;
    const local = await this.loadMessages(target.session.claude_session_id!, {
      dir: target.profile.workspace_dir,
    });
    return findNativeTaskNotificationProof(local, query);
  }

  private async inspectTarget(
    targetSessionId: string | null,
    inputUuid: string,
    preferSameNodeLocal: boolean,
    expectedAssistantUuid?: string,
  ): Promise<ClaudeDeliveryTranscriptReceipt> {
    const target = await this.resolveTarget(targetSessionId);
    if (target.kind === "absent") {
      return { kind: "absent", inputUuid };
    }
    if (target.kind === "unavailable") {
      return {
        kind: "unavailable",
        inputUuid,
        reason: target.reason,
      };
    }
    const { session, profile } = target;

    const shared = await this.loadMessages(session.claude_session_id!, {
      dir: profile.workspace_dir,
      sessionStore: this.deps.sessionStore,
    });
    const sharedReceipt = findClaudeDeliveryTranscriptReceipt(
      shared,
      inputUuid,
      expectedAssistantUuid,
    );
    if (
      sharedReceipt.kind === "completed" ||
      (!preferSameNodeLocal && sharedReceipt.kind !== "absent")
    ) return sharedReceipt;

    if (session.node_id === this.deps.sourceNode) {
      const local = await this.loadMessages(session.claude_session_id!, {
        dir: profile.workspace_dir,
      });
      const localReceipt = findClaudeDeliveryTranscriptReceipt(
        local,
        inputUuid,
        expectedAssistantUuid,
      );
      return localReceipt.kind === "absent" && sharedReceipt.kind !== "absent"
        ? sharedReceipt
        : localReceipt;
    }
    if (sharedReceipt.kind !== "absent") return sharedReceipt;
    return {
      kind: "unavailable",
      inputUuid,
      reason: "remote_transcript_not_mirrored",
    };
  }

  private async resolveTarget(
    targetSessionId: string | null,
  ): Promise<ClaudeTranscriptTarget> {
    if (!targetSessionId) return { kind: "absent" };
    const session = await this.deps.getSession(targetSessionId);
    if (!session?.claude_session_id) return { kind: "absent" };
    const profile = session.agent_id
      ? this.deps.getAgent(session.agent_id)
      : undefined;
    if (!profile) {
      return { kind: "unavailable", reason: "target_agent_profile_unavailable" };
    }
    const backend = session.model_preset
      ? this.deps.getModelPresetBackend?.(session.model_preset)
      : profile.backend;
    if (!backend) {
      return { kind: "unavailable", reason: "target_model_preset_unavailable" };
    }
    return backend === "claude"
      ? { kind: "ready", session, profile }
      : { kind: "absent" };
  }
}

export function findClaudeDeliveryTranscriptReceipt(
  messages: SessionMessage[],
  inputUuid: string,
  expectedAssistantUuid?: string,
): ClaudeDeliveryTranscriptReceipt {
  const inputIndex = messages.findIndex(
    (message) => message.type === "user" && message.uuid === inputUuid,
  );
  if (inputIndex < 0) return { kind: "absent", inputUuid };
  const ownedTurn = messages.slice(inputIndex + 1);
  const nextInputIndex = ownedTurn.findIndex((message) =>
    message.type === "user" &&
    isTurnStartingUserInput(message as unknown as Record<string, unknown>)
  );
  const assistant = ownedTurn
    .slice(0, nextInputIndex < 0 ? undefined : nextInputIndex)
    .find((message) =>
      message.type === "assistant" &&
      (expectedAssistantUuid === undefined || message.uuid === expectedAssistantUuid)
    );
  return assistant
    ? {
        kind: "completed",
        inputUuid,
        assistantMessageUuid: assistant.uuid,
      }
    : { kind: "input_pending", inputUuid };
}

function findNativeTaskNotificationProof(
  messages: SessionMessage[],
  query: ClaudeNativeTaskNotificationTranscriptQuery,
): ClaudeNativeTaskNotificationTranscriptProof | null {
  const assistantIndex = messages.findIndex((message) =>
    message.type === "assistant" && message.uuid === query.expectedAssistantUuid
  );
  if (assistantIndex < 0) return null;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.type !== "user") continue;
    const record = message as unknown as Record<string, unknown>;
    if (!isTurnStartingUserInput(record)) continue;
    if (!message.uuid) return null;
    const prompt = userMessageText(record);
    const parsed = prompt ? parseClaudeNativeTaskNotification(prompt) : undefined;
    return parsed?.taskId === query.taskId &&
        parsed.toolUseId === query.initiatingToolUseId
      ? {
          kind: "completed",
          inputUuid: message.uuid,
          assistantMessageUuid: query.expectedAssistantUuid,
        }
      : null;
  }
  return null;
}
