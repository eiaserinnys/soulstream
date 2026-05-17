/**
 * EnginePort interface compliance test.
 *
 * fake EnginePort 구현이 컴파일 통과하고 메서드 호출이 정상 동작하면 interface 시그니처가 정합.
 * 새 백엔드 추가 시 같은 패턴으로 fake adapter 작성하여 interface 표면 검증.
 */

import { describe, expect, it } from "vitest";

import type {
  BackendId,
  EngineExecuteParams,
  EnginePort,
  SSEEventPayload,
  SupportsCompact,
  SupportsThreadFork,
} from "../../src/engine/protocol.js";

/** fake compliance — interface 시그니처 검증용. 실제 백엔드 호출 없음. */
class FakeEngineAdapter implements EnginePort {
  public readonly backendId: BackendId = "codex";
  public closed = false;
  public interruptCalled = 0;
  public lastParams: EngineExecuteParams | null = null;

  constructor(public readonly workspaceDir: string) {}

  async *execute(params: EngineExecuteParams): AsyncIterable<SSEEventPayload> {
    this.lastParams = params;
    yield { type: "session", session_id: "fake-thread-1" } as SSEEventPayload;
    yield { type: "complete" } as SSEEventPayload;
  }

  async interrupt(): Promise<boolean> {
    this.interruptCalled += 1;
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("EnginePort interface compliance", () => {
  it("FakeEngineAdapter가 EnginePort 시그니처를 만족한다 (typecheck + 런타임)", async () => {
    const engine: EnginePort = new FakeEngineAdapter("/tmp/work");
    expect(engine.workspaceDir).toBe("/tmp/work");
    expect(engine.backendId).toBe("codex");
  });

  it("execute가 AsyncIterable<SSEEventPayload>를 반환하고 yield 순서가 유지된다", async () => {
    const engine = new FakeEngineAdapter("/tmp/work");
    const events: SSEEventPayload[] = [];
    for await (const event of engine.execute({ prompt: "test" })) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("session");
    expect(events[1]?.type).toBe("complete");
  });

  it("execute params가 어댑터에 그대로 전달된다", async () => {
    const engine = new FakeEngineAdapter("/tmp/work");
    const params: EngineExecuteParams = {
      prompt: "p",
      resumeSessionId: "sess-1",
      model: "gpt-5",
      systemPrompt: "be brief",
      extraEnv: { CODEX_API_KEY: "test-api-key" },
    };
    for await (const _ of engine.execute(params)) {
      // drain
    }
    expect(engine.lastParams).toEqual(params);
  });

  it("interrupt가 boolean을 반환한다", async () => {
    const engine = new FakeEngineAdapter("/tmp/work");
    expect(await engine.interrupt()).toBe(true);
    expect(engine.interruptCalled).toBe(1);
  });

  it("close가 idempotent하게 동작한다", async () => {
    const engine = new FakeEngineAdapter("/tmp/work");
    await engine.close();
    await engine.close();
    expect(engine.closed).toBe(true);
  });
});

describe("BackendId type alias 분리 (P2)", () => {
  it("BackendId가 'claude' | 'codex' literal union을 받는다", () => {
    const c: BackendId = "claude";
    const x: BackendId = "codex";
    expect([c, x]).toEqual(["claude", "codex"]);
  });
});

describe("Supports* 선택적 capability — interface 시그니처만 검증", () => {
  it("SupportsCompact가 compact(sessionId) 메서드를 요구한다", async () => {
    class CompactSupporter implements SupportsCompact {
      called: string[] = [];
      async compact(sessionId: string): Promise<void> {
        this.called.push(sessionId);
      }
    }
    const s = new CompactSupporter();
    await s.compact("sess-1");
    expect(s.called).toEqual(["sess-1"]);
  });

  it("SupportsThreadFork가 threadFork(sourceSessionId) → 새 sessionId 메서드를 요구한다", async () => {
    class ForkSupporter implements SupportsThreadFork {
      async threadFork(sourceSessionId: string): Promise<string> {
        return `${sourceSessionId}-fork`;
      }
    }
    const s = new ForkSupporter();
    expect(await s.threadFork("sess-1")).toBe("sess-1-fork");
  });

  it("EnginePort 구현체에 Supports*가 *선택적* — Codex 어댑터는 미구현", () => {
    const engine: EnginePort = new FakeEngineAdapter("/tmp");
    // 본 PR의 Codex 어댑터는 둘 다 미구현. in-operator로 분기 가능.
    expect("compact" in engine).toBe(false);
    expect("threadFork" in engine).toBe(false);
  });
});
