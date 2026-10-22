import type { NodeRegistryEvent } from "../node/registry.js";
import type { CardNotification } from "../cards/card_dispatcher.js";
import type { PersistentReportEntry } from "@soulstream/wire-schema/persistent-report";
import type { PushRegistrationRepository } from "./push_routes.js";
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

export type PushSessionReviewState = {
  readonly sessionType: string | null;
  readonly reviewRequired: boolean;
};

export type PushNotifierOptions = {
  readonly provider: PushNotificationProvider;
  readonly repository: PushNotificationRepository;
  readonly catalog: PushNotificationCatalog;
  /** Legacy event-path dependencies remain optional for callers that still provide them. */
  readonly sessionLookup?: (sessionId: string) => Record<string, unknown> | undefined;
  readonly loadSessionReviewState?: (
    sessionId: string,
  ) => Promise<PushSessionReviewState | undefined>;
  readonly resolveNodeEmail: (nodeId: string) => string | undefined;
  readonly foregroundObservers?: SessionForegroundObserverTracker;
  readonly onInfo?: (event: PushNotificationLogEvent) => void;
  readonly onWarning: (message: string, error?: unknown) => void;
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
  readonly reason:
    | "notification_dispatched"
    | "duplicate_event_identity"
    | "review_state_unavailable"
    | "review_not_required"
    | "llm_session";
};

export const PUSH_TOOL_INPUT_TTL_MS = 60 * 60_000;
export const PUSH_EVENT_MAX_AGE_MS = 10 * 60_000;
const PUSH_BODY_MAX = 100;

export class PushNotifier {
  private readonly pending = new Set<Promise<void>>();
  private readonly warn: (message: string, error?: unknown) => void;
  private readonly nowMs: () => number;
  private closed = false;

  constructor(private readonly options: PushNotifierOptions) {
    this.warn = options.onWarning;
    this.nowMs = options.nowMs ?? Date.now;
  }

  async notifyCard(input: CardNotification): Promise<boolean> {
    if (this.closed || input.kind !== "review") return false;
    return this.trackSend(this.notifyReviewCard(input));
  }

  private async notifyReviewCard(input: CardNotification): Promise<boolean> {
    if (await this.folderExcludes(input.folderId)) return false;
    const title = `검수 요청: ${input.title}`;
    return this.sendToUser(input.nodeId, title, title, {
      cardId: input.cardId,
      folderId: input.folderId,
      kind: "card_review",
    });
  }

  async notifyPersistentReport(input: {
    ownerEmail: string;
    sessionId: string;
    entry: PersistentReportEntry;
    cardId?: string;
    questionId?: string;
    folderId?: string;
  }): Promise<boolean> {
    if (this.closed || !input.ownerEmail.trim() || input.entry.state !== "open") {
      return false;
    }
    return this.trackSend(this.notifyPersistentReportOwner(input));
  }

  private async notifyPersistentReportOwner(input: {
    ownerEmail: string;
    sessionId: string;
    entry: PersistentReportEntry;
    cardId?: string;
    questionId?: string;
    folderId?: string;
  }): Promise<boolean> {
    let folderId = input.folderId;
    try {
      if (input.cardId !== undefined) {
        if (input.folderId === undefined || await this.folderExcludes(input.folderId)) {
          return false;
        }
      } else {
        folderId ??= (await this.options.catalog.findSessionFolderId(input.sessionId)) ?? undefined;
        if (folderId !== undefined && await this.folderExcludes(folderId)) return false;
      }
    } catch (error) {
      this.warn(`Push folder settings lookup failed for ${input.sessionId}`, error);
    }

    const title = input.entry.kind === "ask"
      ? `확인 요청: ${input.entry.title}`
      : `지금의 보고: ${input.entry.title}`;
    const body = truncate(firstMeaningful(
      input.entry.context,
      input.entry.action,
      input.entry.title,
    ), PUSH_BODY_MAX);
    return this.sendToEmail(input.ownerEmail.trim(), title, body, {
      kind: "persistent_report",
      persistentSessionId: input.sessionId,
      entryKey: input.entry.key,
      reportKind: input.entry.kind,
      ...(input.cardId ? { cardId: input.cardId } : {}),
      ...(input.questionId ? { questionId: input.questionId } : {}),
      ...(input.folderId ? { folderId: input.folderId } : {}),
    });
  }

  /** Session events continue to update in-app state through their existing SSE path. */
  accept(events: readonly NodeRegistryEvent[]): void {
    void events;
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

  getStats(): {
    toolInputs: number;
    notificationEvents: number;
    pendingSends: number;
  } {
    return {
      toolInputs: 0,
      notificationEvents: 0,
      pendingSends: this.pending.size,
    };
  }

  sweepExpired(nowMs = this.nowMs()): {
    toolInputs: number;
    notificationEvents: number;
    total: number;
  } {
    void nowMs;
    return { toolInputs: 0, notificationEvents: 0, total: 0 };
  }

  private async folderExcludes(folderId: string): Promise<boolean> {
    const folders = await this.options.catalog.listFolders();
    return folders.some((folder) => {
      const record = recordValue(folder);
      const settings = recordValue(record?.settings);
      return record?.id === folderId && settings?.excludeFromNotification === true;
    });
  }

  private async sendToUser(
    nodeId: string,
    title: string,
    body: string,
    data: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    const email = this.options.resolveNodeEmail(nodeId)?.trim();
    if (!email) return false;
    return this.sendToEmail(email, title, body, data);
  }

  private async sendToEmail(
    email: string,
    title: string,
    body: string,
    data: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
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

  private trackSend(send: Promise<boolean>): Promise<boolean> {
    const tracked = send.catch((error: unknown) => {
      this.warn("Push notification send failed", error);
      return false;
    });
    const pending = tracked.then(() => undefined);
    this.pending.add(pending);
    void pending.then(() => this.pending.delete(pending));
    return tracked;
  }
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
  let text = value.slice(0, maxLength - 1).trimEnd();
  const lastSpace = text.lastIndexOf(" ");
  if (lastSpace > (maxLength - 1) * 0.6) text = text.slice(0, lastSpace);
  return `${text}…`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
