import type {
  SessionMessage,
  SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

import type { AgentProfile } from "../agent_registry.js";
import type { ClaudeBackgroundTaskRepository } from
  "../db/repositories/claude_background_task_repository.js";
import type { SessionRow } from "../db/session_db_types.js";
import { attachClaudeBackgroundProvenance } from
  "../engine/claude_background_provenance.js";
import type { ClaudeClientEvent } from "../engine/claude_event_mapper.js";
import { userMessageText } from "../engine/claude_sdk_event_mapper_helpers.js";
import { buildClaudeBackgroundGenerationIdentity } from
  "./claude_background_generation_identity.js";
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
      const sdkSessionId = legacy.sdk_session_id;
      const legacyToolUseId = legacy.tool_use_id;
      if (!sdkSessionId || !legacyToolUseId) continue;
      const session = await this.deps.getSession(legacy.session_id);
      if (
        !session
        || session.claude_session_id !== sdkSessionId
        || !session.agent_id
      ) {
        continue;
      }
      const profile = this.deps.getAgent(session.agent_id);
      if (!profile) continue;
      const backend = session.model_preset
        ? this.deps.getModelPresetBackend?.(session.model_preset)
        : profile.backend;
      if (backend !== "claude") continue;
      const messages = await this.loadMessages(sdkSessionId, {
        dir: profile.workspace_dir,
        sessionStore: this.deps.sessionStore,
        includeSystemMessages: true,
      });
      const candidates = uniqueNativeNotifications(messages)
        .filter((candidate) =>
          candidate.taskId === legacy.task_id
          && candidate.toolUseId !== legacyToolUseId);
      const absent = [];
      for (const candidate of candidates) {
        const existing = await this.deps.repository.getGeneration(
          this.deps.sourceNode,
          legacy.session_id,
          sdkSessionId,
          candidate.taskId,
          candidate.toolUseId,
        );
        if (!existing) absent.push(candidate);
      }
      if (absent.length === 0) continue;
      if (absent.length !== 1) {
        ambiguous += 1;
        continue;
      }
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
        recovered += 1;
      }
    }
    return { examined: legacyRows.length, recovered, ambiguous };
  }
}

interface NativeTaskNotification {
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
    for (const match of text.matchAll(
      /<task-notification\b[^>]*>([\s\S]*?)<\/task-notification>/g,
    )) {
      const body = match[1] ?? "";
      const fields = directXmlFields(body);
      const taskId = fields.get("task-id");
      const toolUseId = fields.get("tool-use-id");
      const status = fields.get("status");
      if (
        !taskId
        || !toolUseId
        || (status !== "completed" && status !== "failed" && status !== "stopped")
      ) {
        continue;
      }
      output.push({
        uuid: message.uuid,
        taskId,
        toolUseId,
        status,
        ...(messages.slice(index + 1).find((item) => item.type === "assistant")
          ? {
            consumedTurnId: messages.slice(index + 1)
              .find((item) => item.type === "assistant")!.uuid,
          }
          : {}),
        ...(fields.get("output-file")
          ? { outputFile: fields.get("output-file") }
          : {}),
        ...(fields.get("summary")
          ? { summary: fields.get("summary") }
          : {}),
      });
    }
  }
  return output;
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

function directXmlFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  const stack: string[] = [];
  let direct: { name: string; contentStart: number } | undefined;
  const tags = /<(\/)?([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?(\/?)>/g;
  for (const match of body.matchAll(tags)) {
    const closing = match[1] === "/";
    const name = match[2]!;
    const selfClosing = match[3] === "/";
    if (closing) {
      if (stack.at(-1) !== name) continue;
      if (stack.length === 1 && direct?.name === name) {
        const value = body.slice(direct.contentStart, match.index).trim();
        if (value) fields.set(name, decodeXml(value));
        direct = undefined;
      }
      stack.pop();
      continue;
    }
    if (selfClosing) continue;
    if (stack.length === 0) {
      direct = { name, contentStart: match.index + match[0].length };
    }
    stack.push(name);
  }
  return fields;
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}
