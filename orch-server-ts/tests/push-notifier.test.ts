import { describe, expect, it, vi } from "vitest";
import type { PersistentReportEntry } from "@soulstream/wire-schema/persistent-report";
import {
  PushNotifier,
  SessionForegroundObserverTracker,
  type NodeRegistryEvent,
  type PushNotificationCatalog,
  type PushNotificationProvider,
  type PushNotificationRepository,
  type PushNotifierOptions,
  type PushSendResult,
} from "../src/index.js";

const OK: PushSendResult = { ok: true, invalidToken: false };

describe("PushNotifier", () => {
  it("does not send session completion, resume compensation, or input-wait pushes", async () => {
    const loadSessionReviewState = vi.fn(async () => ({
      sessionType: "claude",
      reviewRequired: true,
    }));
    const harness = createHarness({ loadSessionReviewState });

    harness.notifier.accept([
      sessionEnded("completed", "completed"),
      sessionEnded("error", "error"),
      sessionEnded("interrupted", "interrupted"),
      sessionEvent("compensated", {
        type: "session_ended",
        status: "completed",
        _dedupe_key: "resume_compensation:compensated:7",
      }),
      sessionEvent("question", { type: "input_request", questions: [{ question: "Continue?", options: [] }] }),
      sessionEvent("plan", { type: "claude_runtime_mode_state", mode: "plan", active: false }),
      sessionEvent("permission", { type: "claude_runtime_notification", notification_type: "permission" }),
      sessionEvent("approval", { type: "tool_approval_requested", tool_name: "Bash" }),
      sessionUpdated("completed"),
    ]);
    await harness.notifier.flush();

    expect(harness.provider.send).not.toHaveBeenCalled();
    expect(loadSessionReviewState).not.toHaveBeenCalled();
    expect(harness.notifier.getStats()).toEqual({
      toolInputs: 0,
      notificationEvents: 0,
      pendingSends: 0,
    });
    expect(harness.notifier.sweepExpired(99_000)).toEqual({
      toolInputs: 0,
      notificationEvents: 0,
      total: 0,
    });
  });

  it("sends only review card notifications and preserves folder exclusions", async () => {
    const harness = createHarness();

    expect(await harness.notifier.notifyCard({
      nodeId: "node-a",
      cardId: "card-a",
      folderId: "folder-a",
      title: "작업",
      kind: "question",
      question: "방향 확인",
    })).toBe(false);
    expect(await harness.notifier.notifyCard({
      nodeId: "node-a",
      cardId: "card-a",
      folderId: "folder-a",
      title: "작업",
      kind: "review",
    })).toBe(true);
    expect(await harness.notifier.notifyCard({
      nodeId: "node-a",
      cardId: "card-b",
      folderId: "hidden",
      title: "제외",
      kind: "review",
    })).toBe(false);

    expect(harness.provider.send).toHaveBeenCalledOnce();
    expect(harness.provider.send).toHaveBeenCalledWith("token-1", "검수 요청: 작업", "검수 요청: 작업", {
      cardId: "card-a",
      folderId: "folder-a",
      kind: "card_review",
    });
  });

  it("sends a Claude account relogin push to the node owner with the claude_account_relogin payload", async () => {
    const harness = createHarness();

    expect(await harness.notifier.notifyClaudeAccountRelogin({
      nodeId: "node-a",
      accountId: "account-a",
      accountEmail: "a@example.com",
    })).toBe(true);

    expect(harness.provider.send).toHaveBeenCalledWith(
      "token-1",
      "클로드 계정 다시 로그인 필요",
      "node-a의 a@example.com 계정 자격 갱신이 끊겼습니다. 설정에서 다시 로그인해 주세요.",
      { kind: "claude_account_relogin", nodeId: "node-a", accountId: "account-a" },
    );
  });

  it("sends open report entries to the owner using the PAS payload keys", async () => {
    const harness = createHarness();
    const ask = reportEntry({
      key: "ask-1",
      kind: "ask",
      title: "선택 확인",
      context: "가장 중요한 내용",
    });
    const see = reportEntry({
      key: "see-1",
      kind: "see",
      title: "진행 상황",
      context: "",
      action: "지금 확인할 내용",
    });

    expect(await harness.notifier.notifyPersistentReport({
      ownerEmail: " owner@example.com ",
      sessionId: "pas-session",
      entry: ask,
    })).toBe(true);
    expect(await harness.notifier.notifyPersistentReport({
      ownerEmail: "owner@example.com",
      sessionId: "pas-session",
      entry: see,
      cardId: "card-a",
      questionId: "question-a",
      folderId: "folder-a",
    })).toBe(true);

    expect(harness.provider.send).toHaveBeenNthCalledWith(1, "token-1", "확인 요청: 선택 확인", "가장 중요한 내용", {
      kind: "persistent_report",
      persistentSessionId: "pas-session",
      entryKey: "ask-1",
      reportKind: "ask",
    });
    expect(harness.provider.send).toHaveBeenNthCalledWith(2, "token-1", "지금의 보고: 진행 상황", "지금 확인할 내용", {
      kind: "persistent_report",
      persistentSessionId: "pas-session",
      entryKey: "see-1",
      reportKind: "see",
      cardId: "card-a",
      questionId: "question-a",
      folderId: "folder-a",
    });
    expect(harness.provider.send.mock.calls[0]![3]).not.toHaveProperty("sessionId");
  });

  it("applies PAS and card folder exclusions, but sends if folder lookup fails", async () => {
    const excluded = createHarness({
      catalog: createCatalog({
        folders: [{ id: "folder-a", settings: { excludeFromNotification: true } }],
      }),
    });
    expect(await excluded.notifier.notifyPersistentReport({
      ownerEmail: "owner@example.com",
      sessionId: "pas-session",
      entry: reportEntry({}),
    })).toBe(false);

    expect(await excluded.notifier.notifyPersistentReport({
      ownerEmail: "owner@example.com",
      sessionId: "pas-session",
      entry: reportEntry({}),
      cardId: "card-a",
      folderId: "folder-a",
    })).toBe(false);
    expect(await excluded.notifier.notifyPersistentReport({
      ownerEmail: "owner@example.com",
      sessionId: "pas-session",
      entry: reportEntry({}),
      cardId: "card-a",
    })).toBe(false);
    expect(excluded.provider.send).not.toHaveBeenCalled();

    const lookupFailed = createHarness({ catalog: createCatalog({ fail: true }) });
    expect(await lookupFailed.notifier.notifyPersistentReport({
      ownerEmail: "owner@example.com",
      sessionId: "pas-session",
      entry: reportEntry({}),
    })).toBe(true);
    expect(lookupFailed.provider.send).toHaveBeenCalledOnce();
    expect(lookupFailed.warn).toHaveBeenCalledOnce();
  });

  it("does not send answered entries or entries without a usable owner email", async () => {
    const harness = createHarness();
    const answered = reportEntry({ state: "answered", answer: "진행" });

    expect(await harness.notifier.notifyPersistentReport({
      ownerEmail: "owner@example.com",
      sessionId: "pas-session",
      entry: answered,
    })).toBe(false);
    expect(await harness.notifier.notifyPersistentReport({
      ownerEmail: "   ",
      sessionId: "pas-session",
      entry: reportEntry({}),
    })).toBe(false);
    await harness.notifier.close();
    expect(await harness.notifier.notifyPersistentReport({
      ownerEmail: "owner@example.com",
      sessionId: "pas-session",
      entry: reportEntry({}),
    })).toBe(false);
    expect(harness.provider.send).not.toHaveBeenCalled();
  });

  it("fans out to every device and removes only invalid tokens", async () => {
    const repository = createRepository([
      { deviceId: "device-ok", expoToken: "token-ok" },
      { deviceId: "device-rate", expoToken: "token-rate" },
      { deviceId: "device-dead", expoToken: "token-dead" },
    ]);
    const provider = createProvider(async token => {
      if (token === "token-rate") return { ok: false, invalidToken: false, error: "MessageRateExceeded" };
      if (token === "token-dead") return { ok: false, invalidToken: true, error: "DeviceNotRegistered" };
      return OK;
    });
    const harness = createHarness({ repository, provider });

    await harness.notifier.notifyCard({
      nodeId: "node-a",
      cardId: "card-a",
      folderId: "folder-a",
      title: "작업",
      kind: "review",
    });

    expect(provider.send).toHaveBeenCalledTimes(3);
    expect(repository.deleteToken).toHaveBeenCalledOnce();
    expect(repository.deleteToken).toHaveBeenCalledWith("owner@example.com", "device-dead");
  });

  it("sends a card question with the card_question payload and a 24-character card title", async () => {
    const harness = createHarness();

    expect(await harness.notifier.notifyCardQuestion({
      ownerEmail: " owner@example.com ",
      cardId: "card-a",
      questionId: "question-a",
      folderId: "folder-a",
      cardTitle: "카드 제목이 아주 길어서 스물네 글자를 넘기는 경우의 제목입니다",
      question: "어느 쪽으로 진행할까요?",
    })).toBe(true);

    expect(harness.provider.send).toHaveBeenCalledOnce();
    expect(harness.provider.send).toHaveBeenCalledWith(
      "token-1",
      "확인 요청: 카드 제목이 아주 길어서 스물네 글자를 넘…",
      "어느 쪽으로 진행할까요?",
      { kind: "card_question", cardId: "card-a", questionId: "question-a", folderId: "folder-a" },
    );
  });

  it("uses the question title and kind for the title while keeping the exact card_question data", async () => {
    const harness = createHarness();
    const data = { kind: "card_question", cardId: "card-a", questionId: "question-a", folderId: "folder-a" };

    expect(await harness.notifier.notifyCardQuestion({
      ownerEmail: "owner@example.com",
      cardId: "card-a",
      questionId: "question-a",
      folderId: "folder-a",
      cardTitle: "카드 제목이 아주 길어서 스물네 글자를 넘기는 경우의 제목입니다",
      question: "배포를 어느 시각에 할까요?",
      questionTitle: "배포 시각",
      questionKind: "choice",
    })).toBe(true);
    expect(await harness.notifier.notifyCardQuestion({
      ownerEmail: "owner@example.com",
      cardId: "card-a",
      questionId: "question-b",
      folderId: "folder-a",
      cardTitle: "카드",
      question: "스테이징에서 직접 확인해 주세요",
      questionTitle: "스테이징 확인",
      questionKind: "request",
    })).toBe(true);
    expect(await harness.notifier.notifyCardQuestion({
      ownerEmail: "owner@example.com",
      cardId: "card-a",
      questionId: "question-c",
      folderId: "folder-a",
      cardTitle: "카드 제목이 아주 길어서 스물네 글자를 넘기는 경우의 제목입니다",
      question: "옛 꼴 질문",
    })).toBe(true);

    expect(harness.provider.send.mock.calls[0]![1]).toBe("확인 요청: 배포 시각");
    expect(harness.provider.send.mock.calls[0]![2]).toBe("배포를 어느 시각에 할까요?");
    expect(harness.provider.send.mock.calls[1]![1]).toBe("부탁: 스테이징 확인");
    expect(harness.provider.send.mock.calls[1]![2]).toBe("스테이징에서 직접 확인해 주세요");
    expect(harness.provider.send.mock.calls[2]![1]).toBe("확인 요청: 카드 제목이 아주 길어서 스물네 글자를 넘…");
    expect(harness.provider.send.mock.calls[0]![3]).toEqual(data);
    expect(harness.provider.send.mock.calls[1]![3]).toEqual({ ...data, questionId: "question-b" });
    expect(harness.provider.send.mock.calls[2]![3]).toEqual({ ...data, questionId: "question-c" });
  });

  it("skips a card question in a folder excluded from notifications", async () => {
    const excluded = createHarness({
      catalog: createCatalog({
        folders: [{ id: "folder-a", settings: { excludeFromNotification: true } }],
      }),
    });

    expect(await excluded.notifier.notifyCardQuestion({
      ownerEmail: "owner@example.com",
      cardId: "card-a",
      questionId: "question-a",
      folderId: "folder-a",
      cardTitle: "카드",
      question: "질문",
    })).toBe(false);
    expect(excluded.provider.send).not.toHaveBeenCalled();
  });

  it("flush and close wait for tracked report sends", async () => {
    let releaseSend!: () => void;
    const blocked = new Promise<void>(resolve => { releaseSend = resolve; });
    const provider = createProvider(async () => {
      await blocked;
      throw new Error("transport failed");
    });
    const harness = createHarness({ provider });
    const sending = harness.notifier.notifyPersistentReport({
      ownerEmail: "owner@example.com",
      sessionId: "pas-session",
      entry: reportEntry({}),
    });
    await vi.waitFor(() => expect(provider.send).toHaveBeenCalledOnce());
    expect(harness.notifier.getStats().pendingSends).toBe(1);

    let closed = false;
    const closing = harness.notifier.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseSend();
    await Promise.all([sending, closing]);
    expect(closed).toBe(true);
    expect(harness.warn).toHaveBeenCalled();
    expect(harness.notifier.getStats().pendingSends).toBe(0);
  });
});

function createHarness(options: {
  repository?: ReturnType<typeof createRepository>;
  provider?: ReturnType<typeof createProvider>;
  catalog?: PushNotificationCatalog;
  onWarning?: PushNotifierOptions["onWarning"];
  loadSessionReviewState?: PushNotifierOptions["loadSessionReviewState"];
} = {}) {
  const repository = options.repository ?? createRepository();
  const provider = options.provider ?? createProvider(async () => OK);
  const warn = options.onWarning ?? vi.fn();
  const loadSessionReviewState = options.loadSessionReviewState ?? vi.fn(async () => undefined);
  return {
    repository,
    provider,
    warn,
    notifier: new PushNotifier({
      provider,
      repository,
      catalog: options.catalog ?? createCatalog(),
      sessionLookup: () => undefined,
      loadSessionReviewState,
      resolveNodeEmail: () => " owner@example.com ",
      foregroundObservers: new SessionForegroundObserverTracker(),
      onWarning: warn,
    }),
  };
}

function createRepository(tokens = [{ deviceId: "device-1", expoToken: "token-1" }]) {
  return {
    upsertToken: vi.fn(async () => undefined),
    listTokens: vi.fn(async () => tokens),
    deleteToken: vi.fn(async () => undefined),
  } satisfies PushNotificationRepository;
}

function createProvider(send: PushNotificationProvider["send"]) {
  return { send: vi.fn(send) };
}

function createCatalog(options: {
  excluded?: boolean;
  fail?: boolean;
  folders?: readonly unknown[];
} = {}): PushNotificationCatalog {
  return {
    async findSessionFolderId() {
      if (options.fail) throw new Error("catalog unavailable");
      return "folder-a";
    },
    async listFolders() {
      if (options.fail) throw new Error("catalog unavailable");
      return options.folders ?? [
        { id: "folder-a", settings: { excludeFromNotification: options.excluded === true } },
        { id: "hidden", settings: { excludeFromNotification: true } },
      ];
    },
  };
}

function reportEntry(overrides: Partial<PersistentReportEntry>): PersistentReportEntry {
  return {
    key: "report-1",
    kind: "ask",
    title: "확인",
    card_numbers: [],
    context: "내용",
    action: "",
    options: ["진행"],
    state: "open",
    answer: "",
    updated_at: "2026-10-22T00:00:00.000Z",
    ...overrides,
  };
}

function sessionUpdated(sessionId: string): NodeRegistryEvent {
  return {
    type: "node_session_session_updated",
    nodeId: "node-a",
    data: { agent_session_id: sessionId, status: "completed" },
  };
}

function sessionEnded(sessionId: string, status: string): NodeRegistryEvent {
  return sessionEvent(sessionId, {
    type: "session_ended",
    status,
    termination_reason: status === "completed" ? "completed_ok" : "error_aborted",
  });
}

function sessionEvent(sessionId: string, event: Record<string, unknown>): NodeRegistryEvent {
  return {
    type: "node_session_event",
    nodeId: "node-a",
    data: {
      type: "event",
      agentSessionId: sessionId,
      event: { _event_id: nextEventId++, ...event },
    },
  };
}

let nextEventId = 1;
