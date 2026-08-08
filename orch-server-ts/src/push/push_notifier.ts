import type { NodeRegistryEvent } from "../node/registry.js";
import { PushNotificationDedupe } from "./push_notification_dedupe.js";
import type { PushRegistrationRepository } from "./push_routes.js";
import {
  responseWaitSignal,
  type ResponseWaitSignal,
} from "./response_wait_signal.js";
import { SessionForegroundObserverTracker } from "./session_foreground_observer_tracker.js";

export { SessionForegroundObserverTracker } from "./session_foreground_observer_tracker.js";
export {
  PUSH_NOTIFICATION_DEDUPE_MAX_ENTRIES,
  PUSH_NOTIFICATION_DEDUPE_TTL_MS,
} from "./push_notification_dedupe.js";

export type PushDeviceToken = {
  readonly deviceId: string;
  readonly expoToken: string;
};

export type PushNotificationRepository = PushRegistrationRepository & {
  listTokens: (email: string) => Promise<readonly PushDeviceToken[]>;
};

export type PushSendResult = {
  readonly ok: boolean;
  readonly invalidToken: boolean;
  readonly error?: string;
};

export type PushNotificationProvider = {
  send: (
    token: string,
    title: string,
    body: string,
    data: Readonly<Record<string, unknown>>,
  ) => Promise<PushSendResult>;
};

export type PushNotificationCatalog = {
  findSessionFolderId: (
    sessionId: string,
  ) => Promise<string | null | undefined> | string | null | undefined;
  listFolders: () => Promise<readonly unknown[]> | readonly unknown[];
};

export type PushNotifierOptions = {
  readonly provider: PushNotificationProvider;
  readonly repository: PushNotificationRepository;
  readonly catalog: PushNotificationCatalog;
  readonly sessionLookup: (sessionId: string) => Record<string, unknown> | undefined;
  readonly resolveNodeEmail: (nodeId: string) => string | undefined;
  readonly foregroundObservers: SessionForegroundObserverTracker;
  readonly onInfo?: (event: PushNotificationLogEvent) => void;
  readonly onWarning?: (message: string, error?: unknown) => void;
  readonly nowMs?: () => number;
};

export type PushNotificationLogEvent = {
  readonly action: "sent" | "suppressed";
  readonly session_id: string;
  readonly event_key: string;
  readonly notification_kind:
    | "session_ended"
    | "ask_user_question"
    | "exit_plan_mode"
    | "permission_prompt"
    | "tool_approval";
  readonly reason: "notification_dispatched" | "duplicate_event_identity";
};

const COMPLETION_SOURCES = new Set(["slack", "browser", "soul-app"]);
const INPUT_REQUEST_SOURCES = new Set([...COMPLETION_SOURCES, "agent"]);
const TERMINAL_NOTIFICATION_TITLES = new Map([
  ["completed", "세션 완료"],
  ["error", "세션 오류"],
]);
export const PUSH_TOOL_INPUT_TTL_MS = 60 * 60_000;
export const PUSH_EVENT_MAX_AGE_MS = 10 * 60_000;
const PUSH_BODY_MAX = 100;
const INPUT_EXCERPT_MAX = 50;

export class PushNotifier {
  private readonly toolInputs = new Map<string, { value: unknown; atMs: number }>();
  private readonly notificationDedupe = new PushNotificationDedupe();
  private readonly pending = new Set<Promise<void>>();
  private readonly warn: (message: string, error?: unknown) => void;
  private readonly nowMs: () => number;
  private closed = false;

  constructor(private readonly options: PushNotifierOptions) {
    this.warn = options.onWarning ?? ((message, error) => console.warn(message, error));
    this.nowMs = options.nowMs ?? Date.now;
  }

  accept(events: readonly NodeRegistryEvent[]): void {
    if (this.closed) return;
    for (const event of events) {
      const task = this.handleEvent(event).catch((error: unknown) => {
        this.warn("Push notifier event failed", error);
      });
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    }
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private async handleEvent(event: NodeRegistryEvent): Promise<void> {
    if (event.type === "node_unregistered") {
      this.clearNodeState(event.nodeId);
      return;
    }
    // Terminal snapshots are observations, not transitions. Only session_ended may notify.
    if (event.type === "node_session_session_updated") return;
    if (event.type !== "node_session_event") return;

    const sessionId = sessionIdFrom(event.data);
    const payload = recordValue(event.data.event) ?? recordValue(event.data.payload);
    if (sessionId === undefined || payload === undefined) return;
    if (payload.type === "session_ended") {
      if (this.isStalePushEvent(sessionId, payload)) return;
      const eventKey = this.claimEvent(sessionId, payload, "session_ended");
      if (eventKey === null) return;
      const sent = await this.handleSessionEnded(event.nodeId, sessionId, event.data, payload);
      if (sent) this.logSent(sessionId, eventKey, "session_ended");
      return;
    }
    this.cacheToolInput(event.nodeId, sessionId, payload);
    const toolUseId = stringValue(payload.tool_use_id, payload.toolUseId);
    const inputKey = toolInputKey(event.nodeId, sessionId, toolUseId);
    const signal = responseWaitSignal(
      payload,
      this.toolInputs.get(inputKey)?.value,
    );
    if (signal?.kind === "exit_plan_mode") this.toolInputs.delete(inputKey);
    if (signal !== undefined) {
      if (this.isStalePushEvent(sessionId, payload)) return;
      const eventKey = this.claimEvent(sessionId, payload, signal.kind);
      if (eventKey === null) return;
      const sent = await this.handleInputRequest(event.nodeId, sessionId, event.data, signal);
      if (sent) this.logSent(sessionId, eventKey, signal.kind);
    }
  }

  private claimEvent(
    sessionId: string,
    event: Record<string, unknown>,
    notificationKind: PushNotificationLogEvent["notification_kind"],
  ): string | undefined | null {
    const claim = this.notificationDedupe.claim(sessionId, event, this.nowMs());
    if (claim === undefined) {
      this.warn(`Push notification event identity missing for ${sessionId}`);
      return undefined;
    }
    if (!claim.duplicate) return claim.eventKey;
    this.options.onInfo?.({
      action: "suppressed",
      session_id: sessionId,
      event_key: claim.eventKey,
      notification_kind: notificationKind,
      reason: "duplicate_event_identity",
    });
    return null;
  }

  private logSent(
    sessionId: string,
    eventKey: string | undefined,
    notificationKind: PushNotificationLogEvent["notification_kind"],
  ): void {
    this.options.onInfo?.({
      action: "sent",
      session_id: sessionId,
      event_key: eventKey ?? "missing",
      notification_kind: notificationKind,
      reason: "notification_dispatched",
    });
  }

  private isStalePushEvent(sessionId: string, event: Record<string, unknown>): boolean {
    const createdAtMs = pushEventCreatedAtMs(event);
    if (createdAtMs === undefined || this.nowMs() - createdAtMs <= PUSH_EVENT_MAX_AGE_MS) return false;
    this.warn(`Push notification skipped for stale event ${sessionId}`);
    return true;
  }

  private async handleSessionEnded(
    nodeId: string,
    sessionId: string,
    envelope: Record<string, unknown>,
    event: Record<string, unknown>,
  ): Promise<boolean> {
    const payload = {
      ...(this.options.sessionLookup(sessionId) ?? {}),
      ...envelope,
      ...event,
    };
    if (normalizedString(payload.session_type, payload.sessionType) === "llm") return false;
    const source = normalizedString(payload.caller_source, payload.callerSource);
    if (!COMPLETION_SOURCES.has(source)) return false;
    const status = normalizedString(payload.status);
    const title = TERMINAL_NOTIFICATION_TITLES.get(status);
    if (title === undefined) return false;
    if (await this.folderExcludes(sessionId, payload)) return false;

    return await this.sendToUser(nodeId, title, completionBody(payload, title), {
      sessionId,
      status,
      sessionType: normalizedString(payload.session_type, payload.sessionType),
      callerSource: source,
    });
  }

  private async handleInputRequest(
    nodeId: string,
    sessionId: string,
    envelope: Record<string, unknown>,
    signal: ResponseWaitSignal,
  ): Promise<boolean> {
    const session = this.options.sessionLookup(sessionId) ?? {};
    const payload = { ...session, ...envelope };
    const sessionType = normalizedString(payload.session_type, payload.sessionType);
    if (sessionType === "llm") return false;
    const source = normalizedString(payload.caller_source, payload.callerSource);
    if (!INPUT_REQUEST_SOURCES.has(source)) return false;
    if (this.options.foregroundObservers.count(sessionId) > 0) return false;
    if (await this.folderExcludes(sessionId, payload)) return false;

    const sessionName = firstMeaningful(
      payload.session_name,
      payload.sessionName,
      payload.display_name,
      payload.displayName,
      payload.prompt,
      sessionId.slice(0, 8),
    );
    const prompt = meaningful(signal.prompt) || "에이전트가 입력을 기다리고 있습니다";
    return await this.sendToUser(
      nodeId,
      signal.title,
      `${truncate(sessionName, 40)}: ${truncate(prompt, INPUT_EXCERPT_MAX)}`,
      {
        sessionId,
        kind: "input_request",
        responseWaitKind: signal.kind,
        sessionType,
        callerSource: source,
      },
    );
  }

  private async folderExcludes(
    sessionId: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const storedFolderId = await this.options.catalog.findSessionFolderId(sessionId);
      const folderId = storedFolderId === undefined
        ? nullableString(payload.folder_id, payload.folderId)
        : storedFolderId;
      if (folderId === null) return false;
      const folders = await this.options.catalog.listFolders();
      return folders.some((folder) => {
        const record = recordValue(folder);
        const settings = recordValue(record?.settings);
        return record?.id === folderId && settings?.excludeFromNotification === true;
      });
    } catch (error) {
      this.warn(`Push folder settings lookup failed for ${sessionId}`, error);
      return false;
    }
  }

  private async sendToUser(
    nodeId: string,
    title: string,
    body: string,
    data: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const email = this.options.resolveNodeEmail(nodeId)?.trim();
    if (!email) return false;
    let tokens: readonly PushDeviceToken[];
    try {
      tokens = await this.options.repository.listTokens(email);
    } catch (error) {
      this.warn(`Push token lookup failed for ${email}`, error);
      return false;
    }
    const results = await Promise.all(tokens.map(async ({ deviceId, expoToken }) => {
      let result: PushSendResult;
      try {
        result = await this.options.provider.send(expoToken, title, body, data);
      } catch (error) {
        this.warn(`Push send failed for ${email}/${deviceId}`, error);
        return false;
      }
      if (result.invalidToken) {
        try {
          await this.options.repository.deleteToken(email, deviceId);
        } catch (error) {
          this.warn(`Push token cleanup failed for ${email}/${deviceId}`, error);
        }
      } else if (!result.ok) {
        this.warn(`Push send rejected for ${email}/${deviceId}: ${result.error ?? "unknown"}`);
      }
      return result.ok;
    }));
    return results.some(Boolean);
  }

  private cacheToolInput(
    nodeId: string,
    sessionId: string,
    event: Record<string, unknown>,
  ): void {
    if (event.type !== "tool_start") return;
    if (stringValue(event.tool_name, event.toolName) !== "ExitPlanMode") return;
    const toolUseId = stringValue(event.tool_use_id, event.toolUseId);
    if (toolUseId.length === 0) return;
    this.toolInputs.set(toolInputKey(nodeId, sessionId, toolUseId), {
      value: event.tool_input ?? event.toolInput,
      atMs: this.nowMs(),
    });
  }

  getStats(): {
    toolInputs: number;
    notificationEvents: number;
    pendingSends: number;
  } {
    return {
      toolInputs: this.toolInputs.size,
      notificationEvents: this.notificationDedupe.size,
      pendingSends: this.pending.size,
    };
  }

  sweepExpired(nowMs = this.nowMs()): {
    toolInputs: number;
    notificationEvents: number;
    total: number;
  } {
    let toolInputs = 0;
    for (const [key, entry] of this.toolInputs) {
      if (nowMs - entry.atMs >= PUSH_TOOL_INPUT_TTL_MS) {
        this.toolInputs.delete(key);
        toolInputs += 1;
      }
    }
    const notificationEvents = this.notificationDedupe.sweepExpired(nowMs);
    return { toolInputs, notificationEvents, total: toolInputs + notificationEvents };
  }

  private clearNodeState(nodeId: string): void {
    const prefix = `${nodeId}\u0000`;
    for (const key of this.toolInputs.keys()) {
      if (key.startsWith(prefix)) this.toolInputs.delete(key);
    }
  }
}

function completionBody(data: Record<string, unknown>, fallbackTitle: string): string {
  const lastMessage = recordValue(data.last_message ?? data.lastMessage);
  return truncate(firstMeaningful(
    data.last_assistant_text,
    data.lastAssistantText,
    lastMessage?.preview,
    data.display_name,
    data.displayName,
    data.last_progress_text,
    data.lastProgressText,
    fallbackTitle,
  ), PUSH_BODY_MAX);
}

function sessionIdFrom(data: Record<string, unknown>): string | undefined {
  return optionalString(data.agentSessionId, data.agent_session_id, data.sessionId, data.session_id);
}

function pushEventCreatedAtMs(event: Record<string, unknown>): number | undefined {
  const value = event.created_at ?? event.createdAt ?? event.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toolInputKey(nodeId: string, sessionId: string, toolUseId: string): string {
  return `${nodeId}\u0000${sessionId}\u0000${toolUseId}`;
}

function firstMeaningful(...values: unknown[]): string {
  for (const value of values) {
    const text = meaningful(value);
    if (text) return text;
  }
  return "";
}

function meaningful(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  if (!text || ["{}", "[]", "null", "undefined"].includes(text)) return "";
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let text = value.slice(0, maxLength).trimEnd();
  const lastSpace = text.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.6) text = text.slice(0, lastSpace);
  return `${text}…`;
}

function normalizedString(...values: unknown[]): string {
  return stringValue(...values).toLowerCase();
}

function optionalString(...values: unknown[]): string | undefined {
  const value = stringValue(...values);
  return value || undefined;
}

function nullableString(...values: unknown[]): string | null {
  return optionalString(...values) ?? null;
}

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
