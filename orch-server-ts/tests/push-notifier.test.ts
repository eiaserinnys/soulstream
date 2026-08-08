import { describe, expect, it, vi } from "vitest";

import {
  PUSH_NOTIFICATION_DEDUPE_TTL_MS,
  PushNotifier,
  SessionForegroundObserverTracker,
  type NodeRegistryEvent,
  type PushNotificationRepository,
  type PushNotificationProvider,
  type PushNotifierOptions,
  type PushSendResult,
} from "../src/index.js";

const OK: PushSendResult = { ok: true, invalidToken: false };

describe("PushNotifier", () => {
  it("suppresses a repeated session_ended event by persistent event identity", async () => {
    const onInfo = vi.fn();
    const harness = createHarness({ onInfo });
    const event = sessionEnded("node-a", "session-a", "completed", { _event_id: 1056 });

    harness.notifier.accept([event, event]);
    await harness.notifier.flush();

    expect(harness.provider.send).toHaveBeenCalledTimes(1);
    expect(onInfo.mock.calls.map(([event]) => event)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "suppressed",
        session_id: "session-a",
        event_key: "session-a:1056",
        reason: "duplicate_event_identity",
      }),
      expect.objectContaining({
        action: "sent",
        session_id: "session-a",
        event_key: "session-a:1056",
        reason: "notification_dispatched",
      }),
    ]));
  });

  it("suppresses a repeated input request by persistent event identity", async () => {
    const harness = createHarness();
    const event = inputRequest("node-a", "session-a", {
      _event_id: 1057,
      request_id: "request-1057",
    });

    harness.notifier.accept([event, event]);
    await harness.notifier.flush();

    expect(harness.provider.send).toHaveBeenCalledTimes(1);
  });

  it("sends completion and error notifications from session_ended transitions only", async () => {
    const harness = createHarness();

    harness.notifier.accept([
      updated("node-a", "session-a", "running"),
      sessionEnded("node-a", "session-a", "completed"),
      updated("node-a", "session-a", "completed"),
      sessionEnded("node-a", "session-b", "error"),
      updated("node-a", "session-b", "error"),
      sessionEvent("node-a", "session-a", { type: "session_ended", status: "interrupted" }),
    ]);
    await harness.notifier.flush();

    expect(harness.provider.send).toHaveBeenCalledTimes(2);
    expect(harness.provider.send).toHaveBeenCalledWith(
      "token-1",
      "세션 완료",
      "작업을 마쳤습니다.",
      expect.objectContaining({ sessionId: "session-a", status: "completed" }),
    );
    expect(harness.provider.send).toHaveBeenCalledWith(
      "token-1",
      "세션 오류",
      "세션 오류",
      expect.objectContaining({ sessionId: "session-b", status: "error" }),
    );
  });

  it("prefers final text carried by the completion wire over stale cached text", async () => {
    const harness = createHarness({
      sessions: new Map([[
        "session-a",
        { ...userSession("browser"), last_assistant_text: "previous turn" },
      ]]),
    });

    harness.notifier.accept([
      sessionEnded("node-a", "session-a", "completed", {
        last_assistant_text: "fresh final answer",
      }),
    ]);
    await harness.notifier.flush();

    expect(harness.provider.send).toHaveBeenCalledWith(
      "token-1",
      "세션 완료",
      "fresh final answer",
      expect.objectContaining({ sessionId: "session-a", status: "completed" }),
    );
  });

  it("keeps last_message preview fallback when an older node omits final text", async () => {
    const harness = createHarness({
      sessions: new Map([[
        "session-a",
        {
          ...userSession("browser"),
          last_message: { preview: "fallback preview" },
        },
      ]]),
    });

    harness.notifier.accept([sessionEnded("node-a", "session-a", "completed")]);
    await harness.notifier.flush();

    expect(harness.provider.send).toHaveBeenCalledWith(
      "token-1",
      "세션 완료",
      "fallback preview",
      expect.objectContaining({ sessionId: "session-a", status: "completed" }),
    );
  });

  it("clears stale cached final text when the completion wire carries null", async () => {
    const harness = createHarness({
      sessions: new Map([[
        "session-a",
        {
          ...userSession("browser"),
          last_assistant_text: "previous turn",
          last_message: { preview: "fallback preview" },
        },
      ]]),
    });

    harness.notifier.accept([
      sessionEnded("node-a", "session-a", "completed", { last_assistant_text: null }),
    ]);
    await harness.notifier.flush();

    expect(harness.provider.send).toHaveBeenCalledWith(
      "token-1",
      "세션 완료",
      "fallback preview",
      expect.objectContaining({ sessionId: "session-a", status: "completed" }),
    );
  });

  it.each([
    ["llm", "browser", 0],
    ["claude", "agent", 0],
    ["claude", "llm", 0],
    ["claude", "channel_observer", 0],
    ["claude", "slack", 1],
    ["claude", "browser", 1],
    ["claude", "soul-app", 1],
  ] as const)(
    "applies completion source policy for %s/%s",
    async (sessionType, callerSource, expected) => {
      const harness = createHarness({
        sessions: new Map([[
          "session-a", { session_type: sessionType, caller_source: callerSource },
        ]]),
      });
      harness.notifier.accept([
        sessionEnded("node-a", "session-a", "completed"),
      ]);
      await harness.notifier.flush();
      expect(harness.provider.send).toHaveBeenCalledTimes(expected);
    },
  );

  it("skips input requests from an external llm caller", async () => {
    const sessions = new Map<string, Record<string, unknown>>([
      [
        "session-a",
        {
          session_type: "claude",
          caller_source: "llm",
          prompt: "External delegation",
        },
      ],
    ]);
    const harness = createHarness({ sessions });

    harness.notifier.accept([
      inputRequest("node-a", "session-a", {
        request_id: "request-llm",
        questions: [{ question: "Continue?", options: [] }],
      }),
    ]);
    await harness.notifier.flush();

    expect(harness.provider.send).not.toHaveBeenCalled();
  });

  it("normalizes input request envelopes with cached session metadata", async () => {
    const sessions = new Map<string, Record<string, unknown>>([
      [
        "session-a",
        {
          session_type: "claude",
          caller_source: "agent",
          prompt: "Investigate notification path",
          folder_id: "folder-a",
        },
      ],
    ]);
    const harness = createHarness({ sessions });

    harness.notifier.accept([
      inputRequest("node-a", "session-a", {
        request_id: "request-a",
        questions: [{ question: "Proceed with the migration?", options: [] }],
      }),
    ]);
    await harness.notifier.flush();

    expect(harness.provider.send).toHaveBeenCalledWith(
      "token-1",
      "입력 요청",
      "Investigate notification path: Proceed with the migration?",
      expect.objectContaining({
        sessionId: "session-a",
        kind: "input_request",
        responseWaitKind: "ask_user_question",
        callerSource: "agent",
      }),
    );
  });

  it("skips input requests while the session has a foreground observer", async () => {
    const observers = new SessionForegroundObserverTracker();
    const release = observers.observe("session-a");
    const harness = createHarness({ observers });

    harness.notifier.accept([inputRequest("node-a", "session-a")]);
    await harness.notifier.flush();
    expect(harness.provider.send).not.toHaveBeenCalled();

    release();
    harness.notifier.accept([inputRequest("node-a", "session-a")]);
    await harness.notifier.flush();
    expect(harness.provider.send).toHaveBeenCalledTimes(1);
  });

  it("supports plan, permission, and tool approval input request titles", async () => {
    const harness = createHarness({
      sessions: new Map([
        ["plan", userSession("browser")],
        ["permission", userSession("slack")],
        ["approval", userSession("agent")],
      ]),
    });

    harness.notifier.accept([
      sessionEvent("node-a", "plan", {
        type: "tool_start",
        tool_name: "ExitPlanMode",
        tool_use_id: "tool-plan",
        tool_input: { plan: "Apply the notifier migration." },
      }),
      sessionEvent("node-a", "plan", {
        type: "claude_runtime_mode_state",
        mode: "plan",
        active: false,
        tool_name: "ExitPlanMode",
        tool_use_id: "tool-plan",
      }),
      sessionEvent("node-a", "permission", {
        type: "claude_runtime_notification",
        notification_type: "permission",
        title: "Permission needed",
        message: "Approve Bash?",
      }),
      sessionEvent("node-a", "approval", {
        type: "tool_approval_requested",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
      }),
    ]);
    await harness.notifier.flush();

    expect(harness.provider.send.mock.calls.map((call) => call[1])).toEqual([
      "플랜 검토 요청",
      "권한 요청",
      "도구 승인 요청",
    ]);
    expect(harness.provider.send.mock.calls.map((call) => call[2])).toEqual([
      "plan: Apply the notifier migration.",
      "permissi: Permission needed: Approve Bash?",
      "approval: Bash: pnpm test",
    ]);
  });

  it("uses assignment folder settings, wire fallback, and graceful lookup fallback", async () => {
    const excludedCatalog = createCatalog({ excluded: true });
    const assignmentHarness = createHarness({ catalog: excludedCatalog });
    assignmentHarness.notifier.accept([inputRequest("node-a", "session-a")]);
    await assignmentHarness.notifier.flush();
    expect(assignmentHarness.provider.send).not.toHaveBeenCalled();

    const wireHarness = createHarness({
      catalog: createCatalog({ excluded: true, assignments: {} }),
      sessions: new Map([["session-a", { ...userSession("browser"), folder_id: "folder-a" }]]),
    });
    wireHarness.notifier.accept([inputRequest("node-a", "session-a")]);
    await wireHarness.notifier.flush();
    expect(wireHarness.provider.send).not.toHaveBeenCalled();

    const failingHarness = createHarness({ catalog: createCatalog({ fail: true }) });
    failingHarness.notifier.accept([inputRequest("node-a", "session-a")]);
    await failingHarness.notifier.flush();
    expect(failingHarness.provider.send).toHaveBeenCalledTimes(1);
  });

  it("fans out to every device and cleans only DeviceNotRegistered tokens", async () => {
    const repository = createRepository([
      { deviceId: "device-ok", expoToken: "token-ok" },
      { deviceId: "device-rate", expoToken: "token-rate" },
      { deviceId: "device-dead", expoToken: "token-dead" },
    ]);
    const provider = createProvider(async (token) => {
      if (token === "token-rate") {
        return { ok: false, invalidToken: false, error: "MessageRateExceeded" };
      }
      if (token === "token-dead") {
        return { ok: false, invalidToken: true, error: "DeviceNotRegistered" };
      }
      return OK;
    });
    const harness = createHarness({ repository, provider });

    harness.notifier.accept([sessionEnded("node-a", "session-a", "completed")]);
    await harness.notifier.flush();

    expect(provider.send).toHaveBeenCalledTimes(3);
    expect(repository.deleteToken).toHaveBeenCalledTimes(1);
    expect(repository.deleteToken).toHaveBeenCalledWith(
      "user@example.com",
      "device-dead",
    );
  });

  it("isolates repository/provider failures and drains accepted work before close", async () => {
    let releaseSend: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const provider = createProvider(async () => {
      await blocked;
      throw new Error("transport failed");
    });
    const warnings = vi.fn();
    const harness = createHarness({ provider, onWarning: warnings });

    expect(() => {
      harness.notifier.accept([sessionEnded("node-a", "session-a", "completed")]);
    }).not.toThrow();
    const closing = harness.notifier.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseSend?.();
    await closing;
    expect(warnings).toHaveBeenCalled();
  });

  it("does not turn review acknowledge or node re-registration snapshots into completions", async () => {
    const harness = createHarness();
    harness.notifier.accept([sessionEnded("node-a", "session-a", "completed")]);
    await harness.notifier.flush();
    harness.notifier.accept([
      updated("node-a", "session-a", "completed", {
        review_required: true,
        review_state: "acknowledged",
      }),
    ]);
    await harness.notifier.flush();
    harness.notifier.accept([{ type: "node_unregistered", nodeId: "node-a", connectionId: "c", reason: "disconnect" }]);
    await harness.notifier.flush();
    harness.notifier.accept([updated("node-a", "session-a", "completed")]);
    await harness.notifier.flush();
    expect(harness.provider.send).toHaveBeenCalledTimes(1);
  });

  it("does not resend after the former ten-minute dedup window expires", async () => {
    let nowMs = 1_000;
    const harness = createHarness({ nowMs: () => nowMs });
    harness.notifier.accept([
      sessionEnded("node-a", "session-a", "completed"),
      updated("node-a", "session-a", "completed"),
    ]);
    await harness.notifier.flush();

    nowMs += 10 * 60_000;
    harness.notifier.sweepExpired(nowMs);
    harness.notifier.accept([updated("node-a", "session-a", "completed")]);
    await harness.notifier.flush();
    expect(harness.provider.send).toHaveBeenCalledTimes(1);
  });

  it("does not resend a terminal snapshot after the notifier is reconstructed", async () => {
    const repository = createRepository();
    const provider = createProvider(async () => OK);
    const first = createHarness({ repository, provider });
    first.notifier.accept([sessionEnded("node-a", "session-a", "completed")]);
    await first.notifier.flush();

    const restarted = createHarness({ repository, provider });
    restarted.notifier.accept([updated("node-a", "session-a", "completed")]);
    await restarted.notifier.flush();

    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it("notifies again when the same session runs and reaches a fresh terminal transition", async () => {
    const harness = createHarness();
    harness.notifier.accept([
      sessionEnded("node-a", "session-a", "completed", { _event_id: 11 }),
      updated("node-a", "session-a", "running"),
      sessionEnded("node-a", "session-a", "completed", { _event_id: 22 }),
    ]);
    await harness.notifier.flush();

    expect(harness.provider.send).toHaveBeenCalledTimes(2);
  });

  it("preserves folder exclusion for terminal transition notifications", async () => {
    const harness = createHarness({ catalog: createCatalog({ excluded: true }) });
    harness.notifier.accept([sessionEnded("node-a", "session-a", "completed")]);
    await harness.notifier.flush();

    expect(harness.provider.send).not.toHaveBeenCalled();
  });

  it("deletes ExitPlanMode input after signal creation and sweeps orphaned input after one hour", async () => {
    let nowMs = 1_000;
    const harness = createHarness({
      nowMs: () => nowMs,
      sessions: new Map([["session-a", userSession("browser")]]),
    });
    harness.notifier.accept([
      sessionEvent("node-a", "session-a", {
        type: "tool_start",
        tool_name: "ExitPlanMode",
        tool_use_id: "tool-plan",
        tool_input: { plan: "Apply the notifier migration." },
      }),
    ]);
    await harness.notifier.flush();
    expect(harness.notifier.getStats().toolInputs).toBe(1);

    harness.notifier.accept([
      sessionEvent("node-a", "session-a", {
        type: "claude_runtime_mode_state",
        mode: "plan",
        active: false,
        tool_name: "ExitPlanMode",
        tool_use_id: "tool-plan",
      }),
    ]);
    await harness.notifier.flush();
    expect(harness.notifier.getStats().toolInputs).toBe(0);

    harness.notifier.accept([
      sessionEvent("node-a", "session-a", {
        type: "tool_start",
        tool_name: "ExitPlanMode",
        tool_use_id: "tool-orphan",
        tool_input: { plan: "Never completed" },
      }),
    ]);
    await harness.notifier.flush();
    nowMs += 60 * 60_000;
    expect(harness.notifier.sweepExpired(nowMs).toolInputs).toBe(1);
    expect(harness.notifier.getStats().toolInputs).toBe(0);
  });

  it("sweeps notification identities after their independent TTL", async () => {
    let nowMs = 1_000;
    const harness = createHarness({ nowMs: () => nowMs });
    harness.notifier.accept([
      sessionEnded("node-a", "session-a", "completed", { _event_id: 1058 }),
    ]);
    await harness.notifier.flush();
    expect(harness.notifier.getStats().notificationEvents).toBe(1);

    nowMs += PUSH_NOTIFICATION_DEDUPE_TTL_MS;
    expect(harness.notifier.sweepExpired(nowMs).notificationEvents).toBe(1);
    expect(harness.notifier.getStats().notificationEvents).toBe(0);
  });
});

function createHarness(options: {
  repository?: ReturnType<typeof createRepository>;
  provider?: ReturnType<typeof createProvider>;
  catalog?: ReturnType<typeof createCatalog>;
  sessions?: Map<string, Record<string, unknown>>;
  observers?: SessionForegroundObserverTracker;
  onInfo?: PushNotifierOptions["onInfo"];
  onWarning?: (message: string, error?: unknown) => void;
  nowMs?: () => number;
} = {}) {
  const repository = options.repository ?? createRepository();
  const provider = options.provider ?? createProvider(async () => OK);
  const sessions = options.sessions ?? new Map([
    ["session-a", { ...userSession("browser"), last_assistant_text: "작업을 마쳤습니다." }],
    ["session-b", userSession("slack")],
  ]);
  return {
    repository,
    provider,
    notifier: new PushNotifier({
      provider,
      repository,
      catalog: options.catalog ?? createCatalog(),
      sessionLookup: (sessionId) => sessions.get(sessionId),
      resolveNodeEmail: () => "user@example.com",
      foregroundObservers: options.observers ?? new SessionForegroundObserverTracker(),
      onInfo: options.onInfo,
      onWarning: options.onWarning ?? vi.fn(),
      nowMs: options.nowMs,
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
  assignments?: Record<string, { folderId: string | null }>;
} = {}) {
  return {
    async findSessionFolderId(sessionId: string) {
      if (options.fail) throw new Error("catalog unavailable");
      const assignments = options.assignments ?? {
        "session-a": { folderId: "folder-a" },
      };
      return assignments[sessionId]?.folderId;
    },
    async listFolders() {
      if (options.fail) throw new Error("catalog unavailable");
      return [{
        id: "folder-a",
        settings: { excludeFromNotification: options.excluded === true },
      }];
    },
  };
}

function userSession(source: string): Record<string, unknown> {
  return { session_type: "claude", caller_source: source };
}

function updated(
  nodeId: string,
  sessionId: string,
  status: string,
  extra: Record<string, unknown> = {},
): NodeRegistryEvent {
  return {
    type: "node_session_session_updated",
    nodeId,
    data: {
      agent_session_id: sessionId,
      status,
      session_type: "claude",
      caller_source: "browser",
      ...extra,
    },
  };
}

function inputRequest(
  nodeId: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
): NodeRegistryEvent {
  return sessionEvent(nodeId, sessionId, {
    type: "input_request",
    questions: [{ question: "Continue?", options: [] }],
    ...extra,
  });
}

function sessionEnded(
  nodeId: string, sessionId: string, status: "completed" | "error",
  extra: Record<string, unknown> = {},
): NodeRegistryEvent {
  return sessionEvent(nodeId, sessionId, {
    type: "session_ended",
    status,
    termination_reason: status === "completed" ? "completed_ok" : "error_aborted",
    ...extra,
  });
}

function sessionEvent(
  nodeId: string,
  sessionId: string,
  event: Record<string, unknown>,
): NodeRegistryEvent {
  return {
    type: "node_session_event",
    nodeId,
    data: {
      type: "event",
      agentSessionId: sessionId,
      event: { _event_id: nextEventId++, ...event },
    },
  };
}

let nextEventId = 10_000;
