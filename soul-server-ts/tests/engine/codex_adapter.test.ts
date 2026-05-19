/**
 * CodexEngineAdapter 단위 테스트.
 *
 * `@openai/codex-sdk`의 Codex/Thread를 vi.mock으로 대체하여 어댑터 lifecycle을 검증한다.
 * 실제 Codex 프로세스를 spawn하지 않는다.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import pino from "pino";

import type { ThreadEvent } from "@openai/codex-sdk";

// vi.hoisted로 mock 함수들을 hoist하여 vi.mock factory에서 접근 가능하게 함.
const { mockStartThread, mockResumeThread, mockRunStreamed, mockCodexCtor } = vi.hoisted(
  () => ({
    mockStartThread: vi.fn(),
    mockResumeThread: vi.fn(),
    mockRunStreamed: vi.fn(),
    mockCodexCtor: vi.fn(),
  }),
);

vi.mock("@openai/codex-sdk", () => {
  return {
    Codex: class MockCodex {
      constructor(options: unknown) {
        mockCodexCtor(options);
      }
      startThread(options: unknown) {
        return mockStartThread(options);
      }
      resumeThread(id: string, options?: unknown) {
        return mockResumeThread(id, options);
      }
    },
  };
});

// 테스트 헬퍼 — async generator 생성.
async function* eventStream(events: ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  for (const e of events) {
    yield e;
  }
}

function silentLogger() {
  return pino({ level: "silent" });
}

beforeEach(() => {
  mockStartThread.mockReset();
  mockResumeThread.mockReset();
  mockRunStreamed.mockReset();
  mockCodexCtor.mockReset();
});

describe("CodexEngineAdapter — 기본 lifecycle", () => {
  it("constructor가 Codex SDK에 apiKey·codexPathOverride·sanitize된 env를 전달한다", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    new CodexEngineAdapter(
      {
        workspaceDir: "/tmp/work",
        apiKey: "test-api-key",
        codexPathOverride: "/usr/local/bin/codex",
        processEnv: {
          HOME: "/home/test",
          PATH: "/usr/bin",
        },
      },
      silentLogger(),
    );
    expect(mockCodexCtor).toHaveBeenCalledWith({
      apiKey: "test-api-key",
      codexPathOverride: "/usr/local/bin/codex",
      baseUrl: undefined,
      env: {
        HOME: "/home/test",
        PATH: "/usr/bin",
      },
    });
  });

  it("backendId = 'codex', workspaceDir 노출", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    expect(engine.backendId).toBe("codex");
    expect(engine.workspaceDir).toBe("/tmp/work");
  });
});

describe("CodexEngineAdapter — env sanitize (OAuth fallback 보호)", () => {
  it("빈 문자열 OPENAI_API_KEY는 SDK env에 포함되지 않는다", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    new CodexEngineAdapter(
      {
        workspaceDir: "/tmp/work",
        processEnv: {
          HOME: "/home/test",
          OPENAI_API_KEY: "",
          PATH: "/usr/bin",
        },
      },
      silentLogger(),
    );
    const passedEnv = mockCodexCtor.mock.calls[0][0].env as Record<string, string>;
    expect(passedEnv).not.toHaveProperty("OPENAI_API_KEY");
    expect(passedEnv.HOME).toBe("/home/test");
    expect(passedEnv.PATH).toBe("/usr/bin");
  });

  it("빈 문자열 CODEX_API_KEY는 SDK env에 포함되지 않는다", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    new CodexEngineAdapter(
      {
        workspaceDir: "/tmp/work",
        processEnv: {
          HOME: "/home/test",
          CODEX_API_KEY: "",
        },
      },
      silentLogger(),
    );
    const passedEnv = mockCodexCtor.mock.calls[0][0].env as Record<string, string>;
    expect(passedEnv).not.toHaveProperty("CODEX_API_KEY");
    expect(passedEnv.HOME).toBe("/home/test");
  });

  it("비어있지 않은 OPENAI_API_KEY는 보존된다 (운영자 의도 존중)", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    new CodexEngineAdapter(
      {
        workspaceDir: "/tmp/work",
        processEnv: {
          HOME: "/home/test",
          OPENAI_API_KEY: "sk-real-key",
        },
      },
      silentLogger(),
    );
    const passedEnv = mockCodexCtor.mock.calls[0][0].env as Record<string, string>;
    expect(passedEnv.OPENAI_API_KEY).toBe("sk-real-key");
  });

  it("undefined 값은 SDK env에 포함되지 않는다 (Record<string,string> 타입 정합)", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    new CodexEngineAdapter(
      {
        workspaceDir: "/tmp/work",
        processEnv: {
          HOME: "/home/test",
          MISSING: undefined,
        },
      },
      silentLogger(),
    );
    const passedEnv = mockCodexCtor.mock.calls[0][0].env as Record<string, string>;
    expect(passedEnv).not.toHaveProperty("MISSING");
    expect(passedEnv.HOME).toBe("/home/test");
  });

  it("processEnv 미지정 시 process.env를 base로 사용한다", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    const originalHome = process.env.HOME;
    const originalEmpty = process.env.OPENAI_API_KEY;
    process.env.HOME = "/process/env/home";
    process.env.OPENAI_API_KEY = "";
    try {
      new CodexEngineAdapter(
        { workspaceDir: "/tmp/work" },
        silentLogger(),
      );
      const passedEnv = mockCodexCtor.mock.calls[0][0].env as Record<string, string>;
      expect(passedEnv.HOME).toBe("/process/env/home");
      expect(passedEnv).not.toHaveProperty("OPENAI_API_KEY");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalEmpty === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalEmpty;
    }
  });
});

describe("CodexEngineAdapter.execute — 새 thread", () => {
  it("resumeSessionId 없으면 startThread 호출 (skipGitRepoCheck=true, workspaceDir 박힘)", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");

    mockStartThread.mockReturnValue({
      runStreamed: mockRunStreamed,
    });
    mockRunStreamed.mockResolvedValue({
      events: eventStream([
        { type: "thread.started", thread_id: "thr-1" },
        { type: "turn.started" },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            output_tokens: 5,
            reasoning_output_tokens: 0,
          },
        },
      ]),
    });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const sseEvents = [];
    for await (const event of engine.execute({ prompt: "hello" })) {
      sseEvents.push(event);
    }

    expect(mockStartThread).toHaveBeenCalledWith({
      workingDirectory: "/tmp/work",
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
    });
    expect(mockResumeThread).not.toHaveBeenCalled();
    expect(sseEvents[0]).toEqual({ type: "session", session_id: "thr-1" });
    // turn.started는 no-op이라 통과
    expect(sseEvents).toHaveLength(2);
    expect(sseEvents[1]).toMatchObject({ type: "complete" });
  });

  it("codex가 item.completed (agent_message)만 emit해도 text_start+text_delta+text_end+complete 시퀀스를 yield한다 — claude 정본 정합", async () => {
    // 분석 캐시 `20260517-1220-codex-ts-subscribe-events.md` §A: codex-rs는 item.started·item.updated를
    // emit하지 않음. 분석 캐시 `20260517-1325-codex-ts-sse-ui-routing.md`: claude 정본 시퀀스는
    // text_start → text_delta → text_end. 클라이언트(soul-ui tree-placer/node-factory)는 text_start
    // 없이는 text_delta·text_end를 silent drop. 어댑터→mapper 통합 시퀀스가 *세 이벤트 모두*를
    // 발행해야 채팅 UI에 본문이 표시된다.
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({
      events: eventStream([
        { type: "thread.started", thread_id: "thr-codex" },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: { id: "msg-0", type: "agent_message", text: "hello world" },
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            cached_input_tokens: 50,
            output_tokens: 3,
            reasoning_output_tokens: 0,
          },
        },
      ]),
    });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const sseEvents: Array<Record<string, unknown>> = [];
    for await (const event of engine.execute({ prompt: "say hello" })) {
      sseEvents.push(event as Record<string, unknown>);
    }

    expect(sseEvents).toHaveLength(5);
    expect(sseEvents[0]).toEqual({ type: "session", session_id: "thr-codex" });
    expect(sseEvents[1]).toMatchObject({ type: "text_start" });
    expect(sseEvents[1].text).toBeUndefined();
    expect(sseEvents[2]).toMatchObject({ type: "text_delta", text: "hello world" });
    expect(sseEvents[3]).toMatchObject({ type: "text_end" });
    expect(sseEvents[3].text).toBeUndefined();
    expect(sseEvents[4]).toMatchObject({ type: "complete" });
  });

  it("model 옵션을 startThread에 그대로 전달", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    for await (const _ of engine.execute({ prompt: "x", model: "gpt-5" })) {
      // drain
    }
    expect(mockStartThread).toHaveBeenCalledWith({
      workingDirectory: "/tmp/work",
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      model: "gpt-5",
    });
  });

  it("onSession 콜백이 thread.started 시 호출됨", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({
      events: eventStream([{ type: "thread.started", thread_id: "thr-x" }]),
    });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const sessions: string[] = [];
    for await (const _ of engine.execute({
      prompt: "x",
      onSession: async (id) => {
        sessions.push(id);
      },
    })) {
      // drain
    }
    expect(sessions).toEqual(["thr-x"]);
  });

  it("onEvent 콜백이 매핑된 SSE payload마다 호출됨 (yield와 별도)", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({
      events: eventStream([
        { type: "thread.started", thread_id: "thr-1" },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
          },
        },
      ]),
    });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const observed: string[] = [];
    for await (const _ of engine.execute({
      prompt: "x",
      onEvent: async (p) => {
        observed.push(p.type);
      },
    })) {
      // drain
    }
    expect(observed).toEqual(["session", "complete"]);
  });
});

describe("CodexEngineAdapter — approvalPolicy 정본 박힘 (Python permission_mode=bypassPermissions 정합)", () => {
  // codex CLI 0.130.0 `exec` 모드는 non-interactive — approval 요청 시 stdin user input 채널이
  // 없어 MCP tool call이 *자동 cancel*된다 (`tool_result.error = "user cancelled MCP tool call"`).
  // codex CLI 도움말 자체가 "Prefer `never` for non-interactive runs"라고 권고.
  // Python claude `client_lifecycle.py:238 permission_mode="bypassPermissions"`와 의미 등가.
  // 어댑터가 모든 turn(startThread·resumeThread)에 `approvalPolicy: "never"`를 명시 박는다.

  it("startThread 호출에 approvalPolicy=never 명시", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    for await (const _ of engine.execute({ prompt: "x" })) {
      // drain
    }
    const calledWith = mockStartThread.mock.calls[0][0] as Record<string, unknown>;
    expect(calledWith.approvalPolicy).toBe("never");
  });

  it("resumeThread 호출에도 approvalPolicy=never 명시 (auto-resume·intervention turn)", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockResumeThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    for await (const _ of engine.execute({
      prompt: "x",
      resumeSessionId: "thr-prior",
    })) {
      // drain
    }
    const calledWith = mockResumeThread.mock.calls[0][1] as Record<string, unknown>;
    expect(calledWith.approvalPolicy).toBe("never");
  });

  it("model 옵션이 추가되어도 approvalPolicy는 유지된다", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    for await (const _ of engine.execute({ prompt: "x", model: "gpt-5" })) {
      // drain
    }
    const calledWith = mockStartThread.mock.calls[0][0] as Record<string, unknown>;
    expect(calledWith.approvalPolicy).toBe("never");
    expect(calledWith.model).toBe("gpt-5");
  });
});

describe("CodexEngineAdapter — sandboxMode=danger-full-access (Python permission_mode=bypassPermissions 정합)", () => {
  // PR #60 fix-forward — 분석 캐시 `20260518-1115-codex-network-retry-sync.md` §A-r2 매트릭스:
  //   - workspace-write + network_access=true + approval=never → MCP cancel
  //   - danger-full-access + approval=never → MCP 결과 반환
  // codex CLI 0.130.0 exec 모드의 MCP tool call은 sandbox 모드와 결합된 별 게이트. networkAccessEnabled는
  // *shell command outbound*에만 영향하고 MCP tool과 무관 — PR #60 오진단의 root cause.
  // Python claude `permission_mode="bypassPermissions"` 의미 등가 = `sandboxMode: "danger-full-access"`.

  it("startThread에 sandboxMode=danger-full-access 명시", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    for await (const _ of engine.execute({ prompt: "x" })) {
      // drain
    }
    const calledWith = mockStartThread.mock.calls[0][0] as Record<string, unknown>;
    expect(calledWith.sandboxMode).toBe("danger-full-access");
    // networkAccessEnabled는 *미박힘* — danger-full-access에 자동 포함이고 키 prefix가
    // workspace_write라 본 모드에서 무의미. PR #60 오진단 정정.
    expect(calledWith.networkAccessEnabled).toBeUndefined();
  });

  it("resumeThread에도 sandboxMode=danger-full-access 명시 (auto-resume·intervention turn)", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockResumeThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    for await (const _ of engine.execute({
      prompt: "x",
      resumeSessionId: "thr-prior",
    })) {
      // drain
    }
    const calledWith = mockResumeThread.mock.calls[0][1] as Record<string, unknown>;
    expect(calledWith.sandboxMode).toBe("danger-full-access");
    expect(calledWith.networkAccessEnabled).toBeUndefined();
  });

  it("model 옵션 동거 시에도 sandboxMode 유지", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    for await (const _ of engine.execute({ prompt: "x", model: "gpt-5" })) {
      // drain
    }
    const calledWith = mockStartThread.mock.calls[0][0] as Record<string, unknown>;
    expect(calledWith.sandboxMode).toBe("danger-full-access");
    expect(calledWith.model).toBe("gpt-5");
  });
});

describe("CodexEngineAdapter.execute — 세션 resume", () => {
  it("resumeSessionId 있으면 resumeThread 호출", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockResumeThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    for await (const _ of engine.execute({
      prompt: "x",
      resumeSessionId: "thr-prior",
    })) {
      // drain
    }
    expect(mockResumeThread).toHaveBeenCalledWith("thr-prior", {
      workingDirectory: "/tmp/work",
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
    });
    expect(mockStartThread).not.toHaveBeenCalled();
  });
});

describe("CodexEngineAdapter — 오류 경로", () => {
  it("thread.runStreamed가 throw하면 error SSE(fatal=true) 발행 후 종료", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockRejectedValue(new Error("init failed"));

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const events = [];
    for await (const e of engine.execute({ prompt: "x" })) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: "error", message: "init failed", fatal: true },
    ]);
  });

  it("stream mid-turn error 이벤트가 mapper 통해 SSE error로 발행", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({
      events: eventStream([
        { type: "thread.started", thread_id: "t1" },
        { type: "error", message: "unrecoverable" },
      ]),
    });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const events = [];
    for await (const e of engine.execute({ prompt: "x" })) {
      events.push(e);
    }
    // B-3: 매퍼가 모든 error/complete payload에 timestamp 박음. session은 timestamp 없음.
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "session", session_id: "t1" });
    expect(events[1]).toMatchObject({
      type: "error",
      message: "unrecoverable",
      fatal: true,
    });
    expect(typeof (events[1] as { timestamp: number }).timestamp).toBe("number");
  });
});

describe("CodexEngineAdapter — P2 자가 보강 검증", () => {
  it("동시 execute 호출 금지 — 진행 중 turn이 있으면 throw (P2-3)", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({
      runStreamed: async (_input: unknown, _opts: unknown) => {
        return {
          events: (async function* () {
            // 영원히 대기 — 첫 turn이 idle 상태
            await new Promise(() => {});
          })(),
        };
      },
    });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );

    // 첫 turn 시작 (drain 하지 않음 — 진행 중 상태 유지)
    const firstTurn = engine.execute({ prompt: "first" });
    const firstIter = firstTurn[Symbol.asyncIterator]();
    // 첫 yield 시도 — Promise pending 상태로 둠
    const firstYieldPromise = firstIter.next();
    await new Promise((r) => setImmediate(r)); // event loop 한 번 돌려서 currentTurn 설정 보장

    // 두 번째 execute 호출 시 throw
    await expect(async () => {
      for await (const _ of engine.execute({ prompt: "second" })) {
        // drain
      }
    }).rejects.toThrow(/concurrent turn not supported/);

    // 첫 turn cleanup
    await engine.close();
    // pending promise 정리
    void firstYieldPromise.catch(() => {});
  });

  it("systemPrompt 옵션이 들어오면 warn 로깅 (silent ignore 방지, P2-2)", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const warnSpy: { msg: string; obj?: object }[] = [];
    const logger = pino({
      level: "warn",
    });
    // pino 내부 write hook
    const originalWarn = logger.warn.bind(logger);
    logger.warn = ((obj: unknown, msg?: string) => {
      if (typeof obj === "string") {
        warnSpy.push({ msg: obj });
      } else {
        warnSpy.push({ msg: msg ?? "", obj: obj as object });
      }
      return originalWarn(obj as object, msg);
    }) as typeof logger.warn;

    const engine = new CodexEngineAdapter({ workspaceDir: "/tmp/work" }, logger);
    for await (const _ of engine.execute({
      prompt: "x",
      systemPrompt: "be brief",
    })) {
      // drain
    }
    expect(warnSpy.some((w) => w.msg.includes("systemPrompt"))).toBe(true);
  });

  it("systemPrompt 미설정 시 warn 발생 안 함", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const warnSpy: string[] = [];
    const logger = pino({ level: "warn" });
    const originalWarn = logger.warn.bind(logger);
    logger.warn = ((obj: unknown, msg?: string) => {
      warnSpy.push(typeof obj === "string" ? obj : msg ?? "");
      return originalWarn(obj as object, msg);
    }) as typeof logger.warn;

    const engine = new CodexEngineAdapter({ workspaceDir: "/tmp/work" }, logger);
    for await (const _ of engine.execute({ prompt: "x" })) {
      // drain
    }
    expect(warnSpy.filter((w) => w.includes("systemPrompt"))).toEqual([]);
  });
});

describe("CodexEngineAdapter — interrupt + close", () => {
  it("진행 중 turn 없으면 interrupt() → false", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    expect(await engine.interrupt()).toBe(false);
  });

  it("진행 중 turn에서 interrupt() → true + AbortController abort", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");

    let capturedSignal: AbortSignal | undefined;
    mockStartThread.mockReturnValue({
      runStreamed: async (
        _input: unknown,
        opts: { signal: AbortSignal },
      ) => {
        capturedSignal = opts.signal;
        return {
          events: (async function* () {
            // signal abort까지 대기
            await new Promise<void>((resolve) => {
              opts.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            // abort 후 throw 시뮬레이션 (실제 SDK 동작 유사)
            const err = new Error("aborted");
            (err as Error & { name: string }).name = "AbortError";
            throw err;
          })(),
        };
      },
    });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );

    const consumePromise = (async () => {
      const out = [];
      for await (const e of engine.execute({ prompt: "x" })) {
        out.push(e);
      }
      return out;
    })();

    // 진행 중 interrupt
    await new Promise((r) => setImmediate(r));
    expect(await engine.interrupt()).toBe(true);
    expect(capturedSignal?.aborted).toBe(true);

    // execute는 abort 후 정상 종료 (error SSE 발행 안 함 — aborted 분기)
    await consumePromise;
  });

  it("close 이후 execute 호출하면 throw", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    await engine.close();
    await expect(async () => {
      for await (const _ of engine.execute({ prompt: "x" })) {
        // drain
      }
    }).rejects.toThrow("close()");
  });

  it("close가 idempotent", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    await engine.close();
    await engine.close();
    // throw 없음.
  });
});

describe("CodexEngineAdapter — Phase 2 attachmentPaths (spec-reviewer 보강 1/3·2/3·§7)", () => {
  it("rejected 입력 → assistant_error yield 후 throw (P1-1: return 대신 throw — task.status=error 보장)", async () => {
    // P1-1 정정: 기존 return은 _consumeEventStream의 for-await 정상 종료로 처리되어
    // task.status="completed"로 설정됨 (사용자 의도 어긋남). throw로 격상하여
    // task_executor catch가 task.status="error"를 설정하도록 보장.
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    // runStreamed가 호출되면 안 됨 — thread 생성 전에 rejected 검사 (P2-2)

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const events: Array<Record<string, unknown>> = [];

    // execute는 iterator이므로 수동 drain하여 throw 이전 yield 이벤트를 수집한다.
    const iter = engine.execute({
      prompt: "test",
      attachmentPaths: ["/tmp/sess-1/1234_doc.pdf"],
    })[Symbol.asyncIterator]();

    // 첫 번째 next()는 assistant_error yield를 반환한다.
    const first = await iter.next();
    expect(first.done).toBe(false);
    events.push(first.value as Record<string, unknown>);

    // 두 번째 next()는 throw를 발생시킨다.
    await expect(iter.next()).rejects.toThrow("Attachment rejected");

    // assistant_error 1건 emit 확인
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant_error");
    expect(events[0].fatal).toBe(false);
    expect(String(events[0].message)).toContain(".pdf");
    // thread 생성 전 검사이므로 startThread·runStreamed 호출 안 됨 (P2-2)
    expect(mockStartThread).not.toHaveBeenCalled();
    expect(mockRunStreamed).not.toHaveBeenCalled();
  });

  it("rejected 복수 → reason들이 , 구분으로 message에 포함 + throw error에도 포함", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );

    const iter = engine.execute({
      prompt: "test",
      attachmentPaths: ["/tmp/a.pdf", "/tmp/b.docx"],
    })[Symbol.asyncIterator]();

    // 첫 yield: assistant_error
    const first = await iter.next();
    expect(first.done).toBe(false);
    const msg = String((first.value as Record<string, unknown>).message);
    expect(msg).toContain(".pdf");
    expect(msg).toContain(".docx");

    // 두 번째 next(): throw
    const throwErr = await iter.next().catch((e: Error) => e);
    expect(throwErr).toBeInstanceOf(Error);
    expect((throwErr as Error).message).toContain("Attachment rejected");
  });

  it("rejected throw 후 currentTurn=null — 동일 어댑터로 다음 turn 실행 가능", async () => {
    // P1-1 부가 검증: throw 전 this.currentTurn = null 설정으로 내부 상태 정리.
    // rejected 후 동일 어댑터 인스턴스로 정상 turn을 재실행할 수 있어야 한다.
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );

    // 첫 번째 execute: rejected → throw
    const iter1 = engine.execute({
      prompt: "first",
      attachmentPaths: ["/tmp/a.pdf"],
    })[Symbol.asyncIterator]();
    await iter1.next(); // assistant_error yield 소비
    await iter1.next().catch(() => {}); // throw 소비

    // 두 번째 execute: 정상 (concurrent 가드 미발동 확인 — currentTurn=null이어야 함)
    const events2: Array<Record<string, unknown>> = [];
    for await (const e of engine.execute({ prompt: "second" })) {
      events2.push(e as Record<string, unknown>);
    }
    // 정상 실행 — throw 없음, startThread 1회 호출
    expect(mockStartThread).toHaveBeenCalledTimes(1);
  });

  it("text-reference 입력 → system_message yield 후 runStreamed 호출 (prompt에 인용 첨가)", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const events: Array<Record<string, unknown>> = [];
    for await (const e of engine.execute({
      prompt: "파일 봐줘",
      attachmentPaths: ["/tmp/sess-1/1234_note.txt"],
    })) {
      events.push(e as Record<string, unknown>);
    }

    // 첫 이벤트: system_message (텍스트 변환 알림)
    expect(events[0].type).toBe("system_message");
    expect(String(events[0].text)).toContain("/tmp/sess-1/1234_note.txt");

    // runStreamed는 호출됨 — 인자가 string (text-reference → string 경로)
    expect(mockRunStreamed).toHaveBeenCalledTimes(1);
    const [calledInput] = mockRunStreamed.mock.calls[0];
    expect(typeof calledInput).toBe("string");
    expect(calledInput as string).toContain("파일 봐줘");
    expect(calledInput as string).toContain("다음 파일들이 첨부되었습니다");
    expect(calledInput as string).toContain("/tmp/sess-1/1234_note.txt");
  });

  it("image 입력 → runStreamed 호출 시 첫 인자가 UserInput[] (string 아님)", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    for await (const _ of engine.execute({
      prompt: "이미지 봐줘",
      attachmentPaths: ["/tmp/sess-1/1234_photo.png"],
    })) {
      // drain
    }

    expect(mockRunStreamed).toHaveBeenCalledTimes(1);
    const [calledInput] = mockRunStreamed.mock.calls[0];
    // image 있으면 UserInput[]
    expect(Array.isArray(calledInput)).toBe(true);
    const arr = calledInput as Array<{ type: string; text?: string; path?: string }>;
    expect(arr[0].type).toBe("text");
    expect(arr[0].text).toBe("이미지 봐줘");
    expect(arr[1].type).toBe("local_image");
    expect(arr[1].path).toBe("/tmp/sess-1/1234_photo.png");
  });

  it("빈 attachmentPaths → 기존 string prompt 그대로 (system_message 없음)", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const events: Array<Record<string, unknown>> = [];
    for await (const e of engine.execute({
      prompt: "hello",
      attachmentPaths: [],
    })) {
      events.push(e as Record<string, unknown>);
    }

    // system_message 없음
    expect(events.find((e) => e.type === "system_message")).toBeUndefined();
    // runStreamed 인자는 string
    const [calledInput] = mockRunStreamed.mock.calls[0];
    expect(calledInput).toBe("hello");
  });

  it("attachmentPaths 미지정 → 기존 동작 유지 (system_message 없음)", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const events: Array<Record<string, unknown>> = [];
    for await (const e of engine.execute({ prompt: "hello" })) {
      events.push(e as Record<string, unknown>);
    }

    expect(events.find((e) => e.type === "system_message")).toBeUndefined();
    const [calledInput] = mockRunStreamed.mock.calls[0];
    expect(calledInput).toBe("hello");
  });

  it("image + text-reference mixed → UserInput[] + 첫 text에 인용 포함 + system_message yield", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const events: Array<Record<string, unknown>> = [];
    for await (const e of engine.execute({
      prompt: "이미지와 파일 분석해줘",
      attachmentPaths: ["/tmp/a.png", "/tmp/b.py"],
    })) {
      events.push(e as Record<string, unknown>);
    }

    // system_message 발화 (text-reference)
    expect(events[0].type).toBe("system_message");
    // runStreamed 인자는 UserInput[] (image 있으므로)
    const [calledInput] = mockRunStreamed.mock.calls[0];
    expect(Array.isArray(calledInput)).toBe(true);
    const arr = calledInput as Array<{ type: string; text?: string; path?: string }>;
    expect(arr[0].type).toBe("text");
    expect(arr[0].text).toContain("이미지와 파일 분석해줘");
    expect(arr[0].text).toContain("- /tmp/b.py");
    expect(arr[1].type).toBe("local_image");
  });
});
