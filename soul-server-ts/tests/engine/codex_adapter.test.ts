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

describe("CodexEngineAdapter — reasoning effort", () => {
  it("model 미지정이면 기본 xhigh를 startThread에 전달", async () => {
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

    expect(mockStartThread.mock.calls[0][0]).toMatchObject({
      modelReasoningEffort: "xhigh",
    });
  });

  it("요청 effort를 ThreadOptions.modelReasoningEffort로 전달", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    for await (const _ of engine.execute({
      prompt: "x",
      model: "gpt-5.5",
      reasoningEffort: "medium",
    })) {
      // drain
    }

    expect(mockStartThread.mock.calls[0][0]).toMatchObject({
      model: "gpt-5.5",
      modelReasoningEffort: "medium",
    });
  });

  it("명백한 비추론 모델이면 reasoning effort를 drop하고 warn 로그를 남긴다", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });
    const warnSpy: string[] = [];
    const logger = pino({ level: "warn" });
    logger.warn = ((obj: unknown, msg?: string) => {
      warnSpy.push(String(msg ?? obj));
    }) as typeof logger.warn;

    const engine = new CodexEngineAdapter({ workspaceDir: "/tmp/work" }, logger);
    for await (const _ of engine.execute({
      prompt: "x",
      model: "gpt-4o",
      reasoningEffort: "high",
    })) {
      // drain
    }

    const options = mockStartThread.mock.calls[0][0] as Record<string, unknown>;
    expect(options.model).toBe("gpt-4o");
    expect(options.modelReasoningEffort).toBeUndefined();
    expect(warnSpy.join("\n")).toContain("dropping reasoning effort");
  });

  it("gpt-4-turbo도 비추론 모델로 보고 reasoning effort를 drop한다", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({ events: eventStream([]) });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    for await (const _ of engine.execute({
      prompt: "x",
      model: "gpt-4-turbo",
      reasoningEffort: "high",
    })) {
      // drain
    }

    const options = mockStartThread.mock.calls[0][0] as Record<string, unknown>;
    expect(options.model).toBe("gpt-4-turbo");
    expect(options.modelReasoningEffort).toBeUndefined();
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
      modelReasoningEffort: "xhigh",
    });
    expect(mockResumeThread).not.toHaveBeenCalled();
    expect(sseEvents[0]).toEqual({ type: "session", session_id: "thr-1" });
    // turn.started는 no-op이라 통과
    expect(sseEvents).toHaveLength(2);
    expect(sseEvents[1]).toMatchObject({ type: "complete" });
  });

  it("imageAttachmentPaths가 있으면 runStreamed에 text + local_image UserInput[]를 전달한다", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");

    mockStartThread.mockReturnValue({
      runStreamed: mockRunStreamed,
    });
    mockRunStreamed.mockResolvedValue({
      events: eventStream([
        { type: "thread.started", thread_id: "thr-image" },
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
    for await (const _ of engine.execute({
      prompt: "이 이미지 설명해줘",
      imageAttachmentPaths: ["/tmp/a.png", "/tmp/b.webp"],
    })) {
      // drain
    }

    expect(mockRunStreamed).toHaveBeenCalledWith(
      [
        { type: "text", text: "이 이미지 설명해줘" },
        { type: "local_image", path: "/tmp/a.png" },
        { type: "local_image", path: "/tmp/b.webp" },
      ],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("imageAttachmentPaths가 비어있으면 기존 문자열 입력 경로를 유지한다", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");

    mockStartThread.mockReturnValue({
      runStreamed: mockRunStreamed,
    });
    mockRunStreamed.mockResolvedValue({
      events: eventStream([
        { type: "thread.started", thread_id: "thr-text" },
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
    for await (const _ of engine.execute({
      prompt: "텍스트만",
      imageAttachmentPaths: [],
    })) {
      // drain
    }

    expect(mockRunStreamed.mock.calls[0][0]).toBe("텍스트만");
  });

  it("codex가 item.completed (agent_message)만 emit하면 assistant_message+complete를 yield한다", async () => {
    // item.completed는 완료된 assistant 말풍선의 durable 정본이므로 assistant_message로
    // emit한다. text_start/text_delta/text_end는 생성 중 live transport에만 사용한다.
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

    expect(sseEvents).toHaveLength(3);
    expect(sseEvents[0]).toEqual({ type: "session", session_id: "thr-codex" });
    expect(sseEvents[1]).toMatchObject({
      type: "assistant_message",
      content: "hello world",
      _final_for_live_stream: true,
    });
    // complete은 턴 종료 메타이며 legacy final text 호환을 위해 result를 유지한다.
    expect(sseEvents[2]).toMatchObject({ type: "complete", result: "hello world" });
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
      modelReasoningEffort: "xhigh",
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
      modelReasoningEffort: "xhigh",
    });
    expect(mockStartThread).not.toHaveBeenCalled();
  });

  it("resume no-rollout 실행 오류는 fatal SSE 없이 graceful 종료", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockResumeThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockRejectedValue(
      new Error(
        "Codex Exec exited with code 1: Error: thread/resume failed: no rollout found for thread id thr-missing (code -32600)",
      ),
    );

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const events = [];
    for await (const e of engine.execute({
      prompt: "x",
      resumeSessionId: "thr-missing",
    })) {
      events.push(e);
    }

    expect(mockResumeThread).toHaveBeenCalledWith("thr-missing", expect.any(Object));
    expect(mockStartThread).not.toHaveBeenCalled();
    expect(events).toEqual([]);
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

  it("SDK d.ts 밖 response_item.function_call이 들어와도 mid-turn fatal error로 바뀌지 않는다", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({
      events: eventStream([
        { type: "thread.started", thread_id: "t1" },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "spawn_agent",
            call_id: "call-1",
            arguments: "{\"agent_type\":\"worker\"}",
          },
        } as unknown as ThreadEvent,
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
    const events = [];
    for await (const e of engine.execute({ prompt: "x" })) {
      events.push(e);
    }

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: "session", session_id: "t1" });
    expect(events[1]).toMatchObject({
      type: "tool_start",
      tool_name: "spawn_agent",
      tool_use_id: "call-1",
    });
    expect(events[2]).toMatchObject({ type: "complete" });
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
    logger.warn = ((obj: unknown, msg?: string) => {
      if (typeof obj === "string") {
        warnSpy.push({ msg: obj });
      } else {
        warnSpy.push({ msg: msg ?? "", obj: obj as object });
      }
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
    logger.warn = ((obj: unknown, msg?: string) => {
      warnSpy.push(typeof obj === "string" ? obj : msg ?? "");
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

// F3 (PR fix/soul-server-ts-chat-sse-python-parity): complete.result enrichment.
// adapter가 turn 단위로 lastAgentText를 추적하여 complete payload에 주입.
// Python `complete.result` 정합 (mcp_session_query PREVIEW_FIELD_MAP `["complete"]="result"`).
describe("CodexEngineAdapter.execute — complete.result enrichment (F3)", () => {
  it("agent_message 여러 번 → 마지막 text가 complete.result로 박힘", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({
      events: eventStream([
        { type: "thread.started", thread_id: "thr-x" },
        {
          type: "item.completed",
          item: { id: "msg-0", type: "agent_message", text: "첫 번째" },
        },
        {
          type: "item.completed",
          item: { id: "msg-1", type: "agent_message", text: "두 번째 (최종)" },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        },
      ]),
    });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const sseEvents: Array<Record<string, unknown>> = [];
    for await (const event of engine.execute({ prompt: "x" })) {
      sseEvents.push(event as Record<string, unknown>);
    }
    const complete = sseEvents.find((e) => e.type === "complete");
    expect(complete).toBeDefined();
    // 마지막 agent_message text가 박힘 (덮어쓰기 동작)
    expect(complete!.result).toBe("두 번째 (최종)");
    // usage는 그대로 보존됨
    expect(complete!.usage).toEqual({
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    });
  });

  it("agent_message 없는 turn → complete.result 키 부재 (graceful, soul-ui 폴백 동작)", async () => {
    // tool-only turn(예: tool 실행 후 즉시 turn 종료) 또는 빈 turn.
    // complete.result가 없으면 soul-ui node-factory.ts:167 `e.result ?? "Session completed"` 폴백 발동.
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({
      events: eventStream([
        { type: "thread.started", thread_id: "thr-empty" },
        {
          type: "turn.completed",
          usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
        },
      ]),
    });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const sseEvents: Array<Record<string, unknown>> = [];
    for await (const event of engine.execute({ prompt: "x" })) {
      sseEvents.push(event as Record<string, unknown>);
    }
    const complete = sseEvents.find((e) => e.type === "complete");
    expect(complete).toBeDefined();
    // result 키 자체가 없음
    expect(complete).not.toHaveProperty("result");
    // usage는 그대로
    expect(complete!.usage).toBeDefined();
  });

  it("agent_message 사이에 tool_result 끼어있어도 마지막 agent_message text가 사용됨", async () => {
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({
      events: eventStream([
        { type: "thread.started", thread_id: "thr-mix" },
        {
          type: "item.completed",
          item: { id: "msg-0", type: "agent_message", text: "사고 중..." },
        },
        {
          type: "item.completed",
          item: {
            id: "cmd-0",
            type: "command_execution",
            command: "ls",
            aggregated_output: "file.txt\n",
            exit_code: 0,
            status: "completed",
          },
        },
        {
          type: "item.completed",
          item: { id: "msg-1", type: "agent_message", text: "최종 답" },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        },
      ]),
    });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const sseEvents: Array<Record<string, unknown>> = [];
    for await (const event of engine.execute({ prompt: "x" })) {
      sseEvents.push(event as Record<string, unknown>);
    }
    const complete = sseEvents.find((e) => e.type === "complete");
    expect(complete!.result).toBe("최종 답");
  });

  it("빈 text agent_message → complete.result에 빈 문자열 (undefined와 구분)", async () => {
    // claude 정합으로 빈 텍스트도 의미 있는 turn 종료. lastAgentText="" → result=""로 박힘.
    const { CodexEngineAdapter } = await import("../../src/engine/codex_adapter.js");
    mockStartThread.mockReturnValue({ runStreamed: mockRunStreamed });
    mockRunStreamed.mockResolvedValue({
      events: eventStream([
        { type: "thread.started", thread_id: "thr-empty-text" },
        {
          type: "item.completed",
          item: { id: "msg-0", type: "agent_message", text: "" },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
        },
      ]),
    });

    const engine = new CodexEngineAdapter(
      { workspaceDir: "/tmp/work" },
      silentLogger(),
    );
    const sseEvents: Array<Record<string, unknown>> = [];
    for await (const event of engine.execute({ prompt: "x" })) {
      sseEvents.push(event as Record<string, unknown>);
    }
    const complete = sseEvents.find((e) => e.type === "complete");
    expect(complete!.result).toBe("");
    // result 키가 *있음* (undefined 아님)
    expect(complete).toHaveProperty("result");
  });
});
