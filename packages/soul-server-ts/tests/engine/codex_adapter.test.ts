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
  it("constructor가 Codex SDK에 apiKey·codexPathOverride를 전달한다", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    new CodexEngineAdapter(
      {
        workspaceDir: "/tmp/work",
        apiKey: "test-api-key",
        codexPathOverride: "/usr/local/bin/codex",
      },
      silentLogger(),
    );
    expect(mockCodexCtor).toHaveBeenCalledWith({
      apiKey: "test-api-key",
      codexPathOverride: "/usr/local/bin/codex",
      baseUrl: undefined,
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
    expect(events).toEqual([
      { type: "session", session_id: "t1" },
      { type: "error", message: "unrecoverable", fatal: true },
    ]);
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
