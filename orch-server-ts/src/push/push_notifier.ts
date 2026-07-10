import type { NodeRegistryEvent } from "../node/registry.js";
import type { PushRegistrationRepository } from "./push_routes.js";

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
  listSessionAssignments: () =>
    | Promise<Readonly<Record<string, unknown>>>
    | Readonly<Record<string, unknown>>;
  listFolders: () => Promise<readonly unknown[]> | readonly unknown[];
};

export type PushNotifierOptions = {
  readonly provider: PushNotificationProvider;
  readonly repository: PushNotificationRepository;
  readonly catalog: PushNotificationCatalog;
  readonly sessionLookup: (sessionId: string) => Record<string, unknown> | undefined;
  readonly resolveNodeEmail: (nodeId: string) => string | undefined;
  readonly foregroundObservers: SessionForegroundObserverTracker;
  readonly onWarning?: (message: string, error?: unknown) => void;
};

type ResponseWaitSignal = {
  readonly kind: "ask_user_question" | "exit_plan_mode" | "permission_prompt" | "tool_approval";
  readonly title: string;
  readonly prompt: string;
};

const COMPLETION_SOURCES = new Set(["slack", "browser", "soul-app"]);
const INPUT_REQUEST_SOURCES = new Set([...COMPLETION_SOURCES, "agent"]);
const TERMINAL_STATUSES = new Set(["completed", "error"]);
const PUSH_BODY_MAX = 100;
const INPUT_EXCERPT_MAX = 50;

export class SessionForegroundObserverTracker {
  private readonly counts = new Map<string, number>();

  observe(sessionId: string): () => void {
    this.counts.set(sessionId, this.count(sessionId) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.count(sessionId) - 1;
      if (next <= 0) this.counts.delete(sessionId);
      else this.counts.set(sessionId, next);
    };
  }

  count(sessionId: string): number {
    return this.counts.get(sessionId) ?? 0;
  }
}

export class PushNotifier {
  private readonly lastStatus = new Map<string, string>();
  private readonly toolInputs = new Map<string, unknown>();
  private readonly pending = new Set<Promise<void>>();
  private readonly warn: (message: string, error?: unknown) => void;
  private closed = false;

  constructor(private readonly options: PushNotifierOptions) {
    this.warn = options.onWarning ?? ((message, error) => console.warn(message, error));
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
    if (event.type === "node_session_session_updated") {
      await this.handleSessionUpdated(event.nodeId, event.data);
      return;
    }
    if (event.type !== "node_session_event") return;

    const sessionId = sessionIdFrom(event.data);
    const payload = recordValue(event.data.event) ?? recordValue(event.data.payload);
    if (sessionId === undefined || payload === undefined) return;
    this.cacheToolInput(event.nodeId, sessionId, payload);
    const signal = responseWaitSignal(
      payload,
      this.toolInputs.get(toolInputKey(event.nodeId, sessionId, stringValue(payload.tool_use_id, payload.toolUseId))),
    );
    if (signal !== undefined) {
      await this.handleInputRequest(event.nodeId, sessionId, event.data, signal);
    }
  }

  private async handleSessionUpdated(
    nodeId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = sessionIdFrom(data);
    if (sessionId === undefined) return;
    const payload = { ...(this.options.sessionLookup(sessionId) ?? {}), ...data };
    if (normalizedString(payload.session_type, payload.sessionType) === "llm") return;
    const source = normalizedString(payload.caller_source, payload.callerSource);
    if (!COMPLETION_SOURCES.has(source)) return;
    const status = normalizedString(payload.status);
    if (status.length === 0) return;

    const statusKey = sessionStateKey(nodeId, sessionId);
    const previous = this.lastStatus.get(statusKey);
    this.lastStatus.set(statusKey, status);
    if (!TERMINAL_STATUSES.has(status) || previous === status) return;
    if (await this.folderExcludes(sessionId, payload)) return;

    const title = status === "completed" ? "세션 완료" : "세션 오류";
    await this.sendToUser(nodeId, title, completionBody(payload, title), {
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
  ): Promise<void> {
    const session = this.options.sessionLookup(sessionId) ?? {};
    const payload = { ...session, ...envelope };
    const sessionType = normalizedString(payload.session_type, payload.sessionType);
    if (sessionType === "llm") return;
    const source = normalizedString(payload.caller_source, payload.callerSource);
    if (!INPUT_REQUEST_SOURCES.has(source)) return;
    if (this.options.foregroundObservers.count(sessionId) > 0) return;
    if (await this.folderExcludes(sessionId, payload)) return;

    const sessionName = firstMeaningful(
      payload.session_name,
      payload.sessionName,
      payload.display_name,
      payload.displayName,
      payload.prompt,
      sessionId.slice(0, 8),
    );
    const prompt = meaningful(signal.prompt) || "에이전트가 입력을 기다리고 있습니다";
    await this.sendToUser(
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
      const assignments = await this.options.catalog.listSessionAssignments();
      const assignment = assignmentFolder(assignments, sessionId);
      const folderId = assignment.found
        ? assignment.folderId
        : nullableString(payload.folder_id, payload.folderId);
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
  ): Promise<void> {
    const email = this.options.resolveNodeEmail(nodeId)?.trim();
    if (!email) return;
    let tokens: readonly PushDeviceToken[];
    try {
      tokens = await this.options.repository.listTokens(email);
    } catch (error) {
      this.warn(`Push token lookup failed for ${email}`, error);
      return;
    }
    await Promise.all(tokens.map(async ({ deviceId, expoToken }) => {
      let result: PushSendResult;
      try {
        result = await this.options.provider.send(expoToken, title, body, data);
      } catch (error) {
        this.warn(`Push send failed for ${email}/${deviceId}`, error);
        return;
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
    }));
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
    this.toolInputs.set(toolInputKey(nodeId, sessionId, toolUseId), event.tool_input ?? event.toolInput);
  }

  private clearNodeState(nodeId: string): void {
    const prefix = `${nodeId}\u0000`;
    for (const key of this.lastStatus.keys()) {
      if (key.startsWith(prefix)) this.lastStatus.delete(key);
    }
    for (const key of this.toolInputs.keys()) {
      if (key.startsWith(prefix)) this.toolInputs.delete(key);
    }
  }
}

function responseWaitSignal(
  event: Record<string, unknown>,
  cachedToolInput: unknown,
): ResponseWaitSignal | undefined {
  if (event.type === "input_request") {
    return {
      kind: "ask_user_question",
      title: "입력 요청",
      prompt: inputRequestExcerpt(event),
    };
  }
  if (
    event.type === "claude_runtime_mode_state" &&
    event.mode === "plan" &&
    event.active === false &&
    stringValue(event.tool_name, event.toolName) === "ExitPlanMode"
  ) {
    return { kind: "exit_plan_mode", title: "플랜 검토 요청", prompt: toolInputExcerpt(cachedToolInput) || "ExitPlanMode" };
  }
  if (event.type === "claude_runtime_notification") {
    const notificationType = normalizedString(event.notification_type, event.notificationType);
    const key = normalizedString(event.key);
    if (notificationType === "permission" || key === "permission") {
      const title = meaningful(event.title);
      const message = meaningful(event.message);
      return {
        kind: "permission_prompt",
        title: "권한 요청",
        prompt: title && message && title !== message ? `${title}: ${message}` : title || message,
      };
    }
  }
  if (event.type === "tool_approval_requested") {
    const toolName = meaningful(event.tool_name ?? event.toolName) || "tool";
    const excerpt = toolInputExcerpt(event.tool_input ?? event.toolInput);
    return {
      kind: "tool_approval",
      title: "도구 승인 요청",
      prompt: excerpt ? `${toolName}: ${excerpt}` : toolName,
    };
  }
  return undefined;
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

function inputRequestExcerpt(event: Record<string, unknown>): string {
  if (Array.isArray(event.questions)) {
    for (const question of event.questions) {
      const record = recordValue(question);
      const text = record === undefined
        ? meaningful(question)
        : firstMeaningful(record.question, record.header, record.label, record.description);
      if (text) return text;
    }
  }
  return firstMeaningful(event.prompt, event.message, event.title);
}

function toolInputExcerpt(value: unknown): string {
  const record = recordValue(value);
  if (record !== undefined) {
    const text = firstMeaningful(
      record.plan,
      record.message,
      record.summary,
      record.content,
      record.prompt,
      record.question,
      record.command,
    );
    if (text) return text;
    const values = Object.values(record);
    if (values.length === 1) return jsonPreview(values[0]);
  }
  return jsonPreview(value);
}

function assignmentFolder(
  assignments: Readonly<Record<string, unknown>>,
  sessionId: string,
): { found: boolean; folderId: string | null } {
  if (!(sessionId in assignments)) return { found: false, folderId: null };
  const assignment = assignments[sessionId];
  const record = recordValue(assignment);
  return {
    found: true,
    folderId: record === undefined
      ? nullableString(assignment)
      : nullableString(record.folderId, record.folder_id),
  };
}

function sessionIdFrom(data: Record<string, unknown>): string | undefined {
  return optionalString(data.agentSessionId, data.agent_session_id, data.sessionId, data.session_id);
}

function sessionStateKey(nodeId: string, sessionId: string): string {
  return `${nodeId}\u0000${sessionId}`;
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

function jsonPreview(value: unknown): string {
  if (typeof value === "string") return meaningful(value);
  try {
    return meaningful(JSON.stringify(value));
  } catch {
    return meaningful(value);
  }
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
