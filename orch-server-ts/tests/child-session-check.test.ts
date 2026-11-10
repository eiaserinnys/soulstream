import { describe, expect, it } from "vitest";

import type { NodeRegistryEvent } from "../src/node/registry_types.js";
import {
  CHILD_SESSION_CHECK_MAX_PER_CHECK,
  CHILD_SESSION_CHECK_THRESHOLD_MS,
  ChildSessionCheckService,
} from "../src/session/child_session_check_service.js";
import type {
  ChildSessionCheckEvent,
  ChildSessionCheckExistingDelivery,
  ChildSessionCheckStore,
  ChildSessionCheckTarget,
  ChildSessionCheckToolStart,
} from "../src/session/child_session_check_repository.js";

const NOW = Date.parse("2026-11-10T20:05:30+09:00");

type FakeDelivery = ChildSessionCheckExistingDelivery & {
  callerSessionId: string;
  childSessionId: string;
};

function target(overrides: Partial<ChildSessionCheckTarget> = {}): ChildSessionCheckTarget {
  return {
    childSessionId: "child-1",
    callerSessionId: "caller-1",
    displayName: "작업 세션",
    agentId: "roselin",
    modelPreset: "deepseek-v4.1-flash",
    nodeId: "node-a",
    sessionCreatedAtMs: Date.parse("2026-11-10T19:00:00+09:00"),
    lastValidEventId: 7,
    lastValidEventType: "tool_result",
    lastValidEventAtMs: Date.parse("2026-11-10T20:00:00+09:00"),
    ...overrides,
  };
}

function event(overrides: Partial<ChildSessionCheckEvent> = {}): ChildSessionCheckEvent {
  return {
    id: 9,
    eventType: "progress",
    createdAtMs: Date.parse("2026-11-10T20:04:00+09:00"),
    payload: { text: "still working" },
    ...overrides,
  };
}

function toolStart(overrides: Partial<ChildSessionCheckToolStart> = {}): ChildSessionCheckToolStart {
  return {
    id: 12,
    toolUseId: "toolu-1",
    toolName: "Bash",
    command: "pnpm test",
    startedAtMs: Date.parse("2026-11-10T20:02:00+09:00"),
    answered: false,
    ...overrides,
  };
}

function harness(options: {
  targets?: ChildSessionCheckTarget[];
  latestEvents?: Record<string, ChildSessionCheckEvent | null>;
  toolStarts?: Record<string, ChildSessionCheckToolStart[]>;
  errors?: Record<string, ChildSessionCheckEvent | null>;
  nodeStates?: Record<string, { connected: boolean; runningSessionIds?: ReadonlySet<string> } | undefined>;
  failDelivery?: () => boolean;
} = {}) {
  let now = NOW;
  let targets = options.targets ?? [target()];
  const deliveries: FakeDelivery[] = [];
  const delivered: Array<{ callerSessionId: string; childSessionId: string; deliveryId: string; text: string }> = [];
  const warnings: string[] = [];
  const store: ChildSessionCheckStore & {
    setTargets(next: ChildSessionCheckTarget[]): void;
    setLatestEvent(sessionId: string, next: ChildSessionCheckEvent | null): void;
  } = {
    listTargets: async () => targets,
    latestEvent: async (sessionId) => options.latestEvents?.[sessionId] ?? null,
    openToolStarts: async (sessionId) => options.toolStarts?.[sessionId] ?? [],
    lastError: async (sessionId) => options.errors?.[sessionId] ?? null,
    findCheckDeliveries: async ({ childSessionId, callerSessionId }) =>
      deliveries.filter((delivery) =>
        delivery.childSessionId === childSessionId
        && delivery.callerSessionId === callerSessionId,
      ),
    deliveryExists: async (deliveryId) => deliveries.some((d) => d.deliveryId === deliveryId),
    setTargets(next) { targets = next; },
    setLatestEvent(sessionId, next) {
      options.latestEvents = { ...(options.latestEvents ?? {}), [sessionId]: next };
    },
  };
  const service = new ChildSessionCheckService({
    store,
    nodeState: (nodeId) => {
      const state = options.nodeStates?.[nodeId];
      return state === undefined
        ? undefined
        : { connected: state.connected, runningSessionIds: state.runningSessionIds };
    },
    deliver: async (input) => {
      if (options.failDelivery?.()) throw new Error("node rejected intervention");
      deliveries.push({ ...input, createdAtMs: now });
      delivered.push(input);
    },
    warn: (message) => { warnings.push(message); },
    nowMs: () => now,
  });
  return {
    service,
    store,
    delivered,
    deliveries,
    warnings,
    advanceTo(ms: number) { now = ms; },
    now() { return now; },
  };
}

function liveEvent(sessionId: string, type: string): NodeRegistryEvent {
  return {
    type: "node_session_event",
    nodeId: "node-a",
    data: { type: "event", agentSessionId: sessionId, event: { type, text: "x" } },
  };
}

describe("ChildSessionCheckService", () => {
  it("does not send at exactly 300000ms and sends on the first check after it", async () => {
    const h = harness();
    h.advanceTo(NOW - CHILD_SESSION_CHECK_THRESHOLD_MS + 3000);
    await h.service.checkOnce();
    expect(h.delivered).toHaveLength(0);

    h.advanceTo(NOW);
    await h.service.checkOnce();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({
      callerSessionId: "caller-1",
      childSessionId: "child-1",
      deliveryId: "child-check:child-1:caller-1:event:7",
    });
  });

  it("measures silence from session creation when the session has no stored event", async () => {
    const h = harness({
      targets: [target({
        lastValidEventId: null,
        lastValidEventType: null,
        lastValidEventAtMs: null,
        sessionCreatedAtMs: NOW - CHILD_SESSION_CHECK_THRESHOLD_MS + 1000,
      })],
    });
    await h.service.checkOnce();
    expect(h.delivered).toHaveLength(0);

    h.advanceTo(NOW + 2000);
    await h.service.checkOnce();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.deliveryId).toBe("child-check:child-1:caller-1:initial");
  });

  it("does not register a second check for the same silent span across checks and service instances", async () => {
    const h = harness();
    await h.service.checkOnce();
    await h.service.checkOnce();

    const restarted = new ChildSessionCheckService({
      store: h.store,
      deliver: async (input) => { h.delivered.push(input); },
      warn: () => {},
      nowMs: h.now,
    });
    await restarted.checkOnce();

    expect(h.delivered).toHaveLength(1);
  });

  it("sends one new check after a valid response is followed by another five quiet minutes", async () => {
    const h = harness();
    await h.service.checkOnce();
    expect(h.delivered).toHaveLength(1);

    const answeredAt = NOW + 1000;
    h.store.setTargets([target({
      lastValidEventId: 20,
      lastValidEventType: "assistant_message",
      lastValidEventAtMs: answeredAt,
    })]);
    h.advanceTo(answeredAt + CHILD_SESSION_CHECK_THRESHOLD_MS);
    await h.service.checkOnce();
    expect(h.delivered).toHaveLength(1);

    h.advanceTo(answeredAt + CHILD_SESSION_CHECK_THRESHOLD_MS + 1);
    await h.service.checkOnce();
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]!.deliveryId).toBe("child-check:child-1:caller-1:event:20");
  });

  it("still checks when only ordinary progress and hook events keep arriving", async () => {
    const h = harness({
      latestEvents: {
        "child-1": event({ createdAtMs: NOW - 1000, eventType: "progress" }),
      },
    });
    await h.service.checkOnce();
    expect(h.delivered).toHaveLength(1);
  });

  it("defers while live text deltas arrive and uses the live first-received time as the token", async () => {
    const h = harness();
    const liveAt = NOW - 60_000;
    h.advanceTo(liveAt);
    h.service.acceptNodeEvents([liveEvent("child-1", "text_delta")]);

    h.advanceTo(NOW);
    await h.service.checkOnce();
    expect(h.delivered).toHaveLength(0);

    h.advanceTo(NOW + CHILD_SESSION_CHECK_THRESHOLD_MS);
    await h.service.checkOnce();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.deliveryId).toBe(`child-check:child-1:caller-1:live:${liveAt}`);
  });

  it("drops live records for sessions that are no longer targets", async () => {
    const h = harness({ targets: [] });
    h.service.acceptNodeEvents([liveEvent("child-1", "text_delta")]);
    await h.service.checkOnce();

    h.store.setTargets([target({
      lastValidEventAtMs: NOW - 10 * 60_000,
      lastValidEventId: 7,
    })]);
    h.advanceTo(NOW);
    await h.service.checkOnce();
    expect(h.delivered).toHaveLength(1);
  });

  it("prints the full message for a quiet child session", async () => {
    const h = harness({
      latestEvents: { "child-1": event() },
      nodeStates: { "node-a": { connected: true, runningSessionIds: new Set(["child-1"]) } },
    });
    await h.service.checkOnce();
    expect(h.delivered[0]!.text).toBe([
      "[하위 세션 확인]",
      "하위 세션에서 5분 이상 유효한 응답이 없습니다. 오래 걸리는 작업을 진행 중인지 확인하세요.",
      "",
      "세션: 작업 세션",
      "세션 ID: child-1",
      "에이전트: roselin",
      "프리셋: deepseek-v4.1-flash",
      "",
      "마지막 유효 응답: 2026-11-10 20:00:00 +09:00 (tool_result)",
      "경과: 5.5분",
      "",
      "마지막 수신 이벤트: 2026-11-10 20:04:00 +09:00 (progress)",
      "응답 판정: 시간을 갱신하지 않는 이벤트(일반 progress, hook 등)",
      "",
      "도구 상태: 결과를 기다리는 도구 시작 기록 없음",
      "도구 이름: 해당 없음",
      "명령 앞부분: 해당 없음",
      "시작 시각: 해당 없음",
      "",
      "노드: node-a 연결됨, 노드가 보고한 실행 목록에 있음",
      "마지막 오류: 없음",
      "확인 시각: 2026-11-10 20:05:30 +09:00",
      "",
      "긴 명령이 도는 중이면 그대로 두고, 멈춘 것으로 보이면 규칙에 따라 같은 세션에 이어서 지시하거나 다른 모델로 넘기세요.",
    ].join("\n"));
  });

  it("describes a pending command tool with a collapsed and truncated command", async () => {
    const command = `  pnpm   --dir   orch-server-ts   test   --minWorkers=1   --maxWorkers=2   ${"x".repeat(200)}`;
    const h = harness({
      toolStarts: { "child-1": [toolStart({ command })] },
    });
    await h.service.checkOnce();
    const text = h.delivered[0]!.text;
    expect(text).toContain("도구 상태: 명령 실행 중으로 보임");
    expect(text).toContain("도구 이름: Bash");
    expect(text).toContain("시작 시각: 2026-11-10 20:02:00 +09:00");
    const commandLine = text.split("\n").find((line) => line.startsWith("명령 앞부분: "))!;
    const rendered = commandLine.slice("명령 앞부분: ".length);
    expect(rendered).toHaveLength(120);
    expect(rendered).not.toMatch(/\s{2,}/);
    expect(rendered.startsWith("pnpm --dir orch-server-ts test")).toBe(true);
  });

  it("describes a tool without a command as waiting for the result", async () => {
    const h = harness({
      toolStarts: { "child-1": [toolStart({ toolName: "Agent", command: null })] },
    });
    await h.service.checkOnce();
    const text = h.delivered[0]!.text;
    expect(text).toContain("도구 상태: 도구 결과 대기 중");
    expect(text).toContain("도구 이름: Agent");
    expect(text).toContain("명령 앞부분: 해당 없음");
  });

  it("reports no pending tool once the result arrived", async () => {
    const h = harness({
      toolStarts: { "child-1": [toolStart({ answered: true })] },
    });
    await h.service.checkOnce();
    expect(h.delivered[0]!.text).toContain("도구 상태: 결과를 기다리는 도구 시작 기록 없음");
  });

  it("lists the newest pending tool first and counts the rest", async () => {
    const h = harness({
      toolStarts: {
        "child-1": [
          toolStart({ id: 30, toolUseId: "toolu-b", toolName: "Read", command: null }),
          toolStart({ id: 20, toolUseId: "toolu-a", toolName: "Bash", command: "sleep 600" }),
          toolStart({ id: 10, toolUseId: "toolu-0", toolName: "Bash", command: "ls", answered: true }),
        ],
      },
    });
    await h.service.checkOnce();
    const text = h.delivered[0]!.text;
    expect(text).toContain("도구 상태: 도구 결과 대기 중");
    expect(text).toContain("도구 이름: Read");
    expect(text).toContain("그 밖에 결과를 기다리는 도구 1개");
  });

  it("does not pair tools by name when the tool_use_id is missing", async () => {
    const h = harness({
      toolStarts: { "child-1": [toolStart({ toolUseId: null, command: "sleep 600" })] },
    });
    await h.service.checkOnce();
    const text = h.delivered[0]!.text;
    expect(text).toContain("도구 상태: 연결 ID가 없어 미확인");
    expect(text).toContain("도구 이름: Bash");
  });

  it("summarizes the newest error with its time and code", async () => {
    const h = harness({
      errors: {
        "child-1": event({
          id: 40,
          eventType: "assistant_error",
          createdAtMs: Date.parse("2026-11-10T20:03:00+09:00"),
          payload: { code: "rate_limit", message: "API Error: rate limited ".repeat(10) },
        }),
      },
    });
    await h.service.checkOnce();
    const line = h.delivered[0]!.text.split("\n").find((l) => l.startsWith("마지막 오류: "))!;
    expect(line).toContain("2026-11-10 20:03:00 +09:00");
    expect(line).toContain("assistant_error");
    expect(line).toContain("rate_limit");
    const summary = line.slice(line.lastIndexOf(") ") + 2);
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(summary.startsWith("API Error: rate limited")).toBe(true);
  });

  it("falls back to placeholders for an unnamed session and a disconnected node", async () => {
    const h = harness({
      targets: [target({ displayName: null, agentId: null, modelPreset: null })],
      nodeStates: { "node-a": { connected: false } },
    });
    await h.service.checkOnce();
    const text = h.delivered[0]!.text;
    expect(text).toContain("세션: 이름 없음");
    expect(text).toContain("에이전트: 미확인");
    expect(text).toContain("프리셋: 미확인");
    expect(text).toContain("노드: node-a 연결 끊김, 노드가 보고한 실행 목록에 보고 없음");
  });

  it("reports the node running list as missing membership when the node reported one", async () => {
    const h = harness({ nodeStates: { "node-a": { connected: true, runningSessionIds: new Set(["other"]) } } });
    await h.service.checkOnce();
    expect(h.delivered[0]!.text).toContain(
      "노드: node-a 연결됨, 노드가 보고한 실행 목록에 없음",
    );
  });

  it("sends at most ten new checks per round and leaves the rest for the next round", async () => {
    const targets = Array.from({ length: 12 }, (_, index) => target({
      childSessionId: `child-${String(index).padStart(2, "0")}`,
      lastValidEventAtMs: NOW - (10 + (11 - index)) * 60_000,
      lastValidEventId: 100 + index,
    }));
    const h = harness({ targets });
    await h.service.checkOnce();
    expect(h.delivered).toHaveLength(CHILD_SESSION_CHECK_MAX_PER_CHECK);
    expect(h.delivered.map((d) => d.childSessionId)).toEqual(
      targets.slice(0, 10).map((t) => t.childSessionId),
    );

    await h.service.checkOnce();
    expect(h.delivered).toHaveLength(12);
    expect(h.delivered.slice(10).map((d) => d.childSessionId)).toEqual(["child-10", "child-11"]);
  });

  it("counts failed deliveries against the per-round limit and retries them next round", async () => {
    const targets = Array.from({ length: 11 }, (_, index) => target({
      childSessionId: `child-${String(index).padStart(2, "0")}`,
      lastValidEventAtMs: NOW - (10 + (11 - index)) * 60_000,
      lastValidEventId: 100 + index,
    }));
    const h = harness({ targets, failDelivery: () => true });
    await h.service.checkOnce();
    expect(h.delivered).toHaveLength(0);
    expect(h.warnings).toHaveLength(CHILD_SESSION_CHECK_MAX_PER_CHECK);
    expect(h.warnings[0]).toContain("child-00");

    await h.service.checkOnce();
    expect(h.warnings).toHaveLength(2 * CHILD_SESSION_CHECK_MAX_PER_CHECK);
  });

  it("does not register again when a check was registered but its dispatch failed", async () => {
    const h = harness();
    h.service = new ChildSessionCheckService({
      store: h.store,
      nodeState: () => undefined,
      deliver: async (input) => {
        h.deliveries.push({ ...input, createdAtMs: h.now() });
        throw new Error("node rejected intervention");
      },
      warn: (message) => { h.warnings.push(message); },
      nowMs: h.now,
    });
    await h.service.checkOnce();
    expect(h.warnings).toHaveLength(1);

    await h.service.checkOnce();
    expect(h.warnings).toHaveLength(1);
  });
});
