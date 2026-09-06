import type {
  SessionMessage,
  SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { AgentProfile } from "../agent_registry.js";
import type {
  ClaudeBackgroundTaskRepository,
  ClaudeBackgroundTaskRow,
} from "../db/repositories/claude_background_task_repository.js";
import type { SessionRow } from "../db/session_db_types.js";
import { attachClaudeBackgroundProvenance } from
  "../engine/claude_background_provenance.js";
import type { ClaudeClientEvent } from "../engine/claude_event_mapper.js";
import { userMessageText } from "../engine/claude_sdk_event_mapper_helpers.js";
import { buildClaudeBackgroundGenerationIdentity } from
  "./claude_background_generation_identity.js";
import {
  findClaudeNativeTaskNotifications,
  type ClaudeNativeTaskNotification,
} from "./claude_native_task_notification.js";
import type { ClaudeBackgroundTaskLifecycle } from
  "./claude_background_task_lifecycle.js";

export interface ClaudeBackgroundGenerationRecoveryPass {
  examined: number;
  recovered: number;
  ambiguous: number;
}

interface ClaudeBackgroundGenerationStartupRecoveryDeps {
  repository: Pick<
    ClaudeBackgroundTaskRepository,
    "terminalForNode" | "getGeneration"
  >;
  lifecycle: Pick<ClaudeBackgroundTaskLifecycle, "observe">;
  recordRelationConsumed(input: {
    relationKey: string;
    completionId: string;
    callerSessionId: string;
    consumedTurnId: string;
  }): Promise<unknown>;
  sourceNode: string;
  sessionStore: SessionStore;
  getSession(sessionId: string): Promise<SessionRow | null>;
  getAgent(agentId: string): AgentProfile | undefined;
  logger: Pick<Logger, "error">;
  getModelPresetBackend?(presetId: string): AgentProfile["backend"] | undefined;
  loadMessages?(
    sessionId: string,
    options: {
      dir: string;
      sessionStore: SessionStore;
      includeSystemMessages: boolean;
    },
  ): Promise<SessionMessage[]>;
}

/** Reconciles exact native terminal evidence omitted by a legacy task-id writer. */
export class ClaudeBackgroundGenerationStartupRecovery {
  private readonly loadMessages: NonNullable<
    ClaudeBackgroundGenerationStartupRecoveryDeps["loadMessages"]
  >;

  constructor(private readonly deps: ClaudeBackgroundGenerationStartupRecoveryDeps) {
    this.loadMessages = deps.loadMessages ?? getSessionMessages;
  }

  async recoverAfterNodeRestart(): Promise<ClaudeBackgroundGenerationRecoveryPass> {
    const legacyRows = await this.deps.repository.terminalForNode(
      this.deps.sourceNode,
    );
    let recovered = 0;
    let ambiguous = 0;
    for (const legacy of legacyRows) {
      try {
        const outcome = await this.recoverLegacyRow(legacy);
        if (outcome === "recovered") recovered += 1;
        if (outcome === "ambiguous") ambiguous += 1;
      } catch (err) {
        this.deps.logger.error(
          {
            err,
            sourceNode: this.deps.sourceNode,
            sessionId: legacy.session_id,
            sdkSessionId: legacy.sdk_session_id,
            taskId: legacy.task_id,
            legacyToolUseId: legacy.tool_use_id,
          },
          "Legacy-lost Claude background generation reconciliation row failed; continuing",
        );
      }
    }
    return { examined: legacyRows.length, recovered, ambiguous };
  }

  private async recoverLegacyRow(
    legacy: ClaudeBackgroundTaskRow,
  ): Promise<"recovered" | "ambiguous" | "skipped"> {
    const sdkSessionId = legacy.sdk_session_id;
    const legacyToolUseId = legacy.tool_use_id;
    if (!sdkSessionId || !legacyToolUseId) return "skipped";
    const session = await this.deps.getSession(legacy.session_id);
    if (
      !session
      || session.claude_session_id !== sdkSessionId
      || !session.agent_id
    ) {
      return "skipped";
    }
    const profile = this.deps.getAgent(session.agent_id);
    if (!profile) return "skipped";
    const backend = session.model_preset
      ? this.deps.getModelPresetBackend?.(session.model_preset)
      : profile.backend;
    if (backend !== "claude") return "skipped";
    const messages = await this.loadMessages(sdkSessionId, {
      dir: profile.workspace_dir,
      sessionStore: this.deps.sessionStore,
      includeSystemMessages: true,
    });
    const candidates = uniqueNativeNotifications(messages)
      .filter((candidate) => candidate.taskId === legacy.task_id);
    const absent = [];
    for (const candidate of candidates) {
      const existing = await this.deps.repository.getGeneration(
        this.deps.sourceNode,
        legacy.session_id,
        sdkSessionId,
        candidate.taskId,
        candidate.toolUseId,
      );
      if (existing) {
        if (candidate.consumedTurnId) {
          await this.deps.recordRelationConsumed({
            relationKey: existing.relation_key,
            completionId: existing.completion_id,
            callerSessionId: legacy.session_id,
            consumedTurnId: candidate.consumedTurnId,
          });
        }
        continue;
      }
      if (candidate.toolUseId !== legacyToolUseId) absent.push(candidate);
    }
    if (absent.length === 0) return "skipped";
    if (absent.length !== 1) return "ambiguous";
    const candidate = absent[0]!;
    if (candidate.consumedTurnId) {
      const identity = buildClaudeBackgroundGenerationIdentity({
        sourceNode: this.deps.sourceNode,
        agentSessionId: legacy.session_id,
        sdkSessionId,
        sdkTaskId: candidate.taskId,
        initiatingToolUseId: candidate.toolUseId,
      });
      await this.deps.recordRelationConsumed({
        relationKey: identity.relationKey,
        completionId: identity.completionId,
        callerSessionId: legacy.session_id,
        consumedTurnId: candidate.consumedTurnId,
      });
    }
    const event: ClaudeClientEvent = {
      type: "claude_runtime_task_notification",
      taskId: candidate.taskId,
      sessionId: sdkSessionId,
      toolUseId: candidate.toolUseId,
      status: candidate.status,
      ...(candidate.outputFile ? { outputFile: candidate.outputFile } : {}),
      ...(candidate.summary ? { summary: candidate.summary } : {}),
    };
    attachClaudeBackgroundProvenance(event, "sdk_membership");
    if (await this.deps.lifecycle.observe(
      legacy.session_id,
      event,
      `upgrade-native-task-notification:${candidate.uuid}`,
    )) {
      return "recovered";
    }
    return "skipped";
  }
}

interface NativeTaskNotification extends ClaudeNativeTaskNotification {
  uuid: string;
  taskId: string;
  toolUseId: string;
  status: "completed" | "failed" | "stopped";
  outputFile?: string;
  summary?: string;
  consumedTurnId?: string;
}

export function findNativeTaskNotifications(
  messages: SessionMessage[],
): NativeTaskNotification[] {
  const output: NativeTaskNotification[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.type !== "user") continue;
    const text = userMessageText(message as unknown as Record<string, unknown>);
    if (!text) continue;
    const parsed = findClaudeNativeTaskNotifications(text);
    if (parsed.length !== 1) continue;
    const assistant = firstAssistantBeforeNextUser(messages, index);
    output.push({
      ...parsed[0]!,
      uuid: message.uuid,
      ...(assistant ? { consumedTurnId: assistant.uuid } : {}),
    });
  }
  return output;
}

function firstAssistantBeforeNextUser(
  messages: SessionMessage[],
  notificationIndex: number,
): SessionMessage | undefined {
  for (const message of messages.slice(notificationIndex + 1)) {
    if (message.type === "user") return undefined;
    if (message.type === "assistant") return message;
  }
  return undefined;
}

function uniqueNativeNotifications(
  messages: SessionMessage[],
): NativeTaskNotification[] {
  const byIdentity = new Map<string, NativeTaskNotification>();
  for (const candidate of findNativeTaskNotifications(messages)) {
    const key = [candidate.taskId, candidate.toolUseId].join("\u0000");
    if (!byIdentity.has(key)) byIdentity.set(key, candidate);
  }
  return [...byIdentity.values()];
}
