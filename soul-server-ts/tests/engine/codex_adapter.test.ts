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
    });
    expect(mockResumeThread).not.toHaveBeenCalled();
    expect(sseEvents[0]).toEqual({ type: "session", session_id: "thr-1" });
    // turn.started는 no-op이라 통과
    expect(sseEvents).toHaveLength(2);
    expect(sseEvents[1]).toMatchObject({ type: "complete" });
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
