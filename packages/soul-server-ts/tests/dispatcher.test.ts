import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import { CommandDispatcher } from "../src/upstream/dispatcher.js";

function createDispatcher(nodeId = "eias-shopping-ts") {
  const sent: unknown[] = [];
  const send = vi.fn(async (data: unknown) => {
    sent.push(data);
  });
  const logger = pino({ level: "silent" });
  const dispatcher = new CommandDispatcher(send, logger, nodeId);
  return { dispatcher, sent, send };
}

describe("CommandDispatcher", () => {
  it("health_check → health_status 응답 (Python command_handler.py L309-317 등가)", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({ type: "health_check", requestId: "req-1" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "health_status",
      runners: { max_concurrent: 0, active: 0 },
      node_id: "eias-shopping-ts",
      requestId: "req-1",
    });
  });

  it("health_check에 requestId 없으면 빈 문자열 fallback", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({ type: "health_check" });
    expect((sent[0] as { requestId: string }).requestId).toBe("");
  });

  it("health_check에 snake_case request_id가 와도 camel로 회신", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({ type: "health_check", request_id: "snake-1" });
    expect((sent[0] as { requestId: string }).requestId).toBe("snake-1");
  });

  it("미구현 명령 → error 응답 (위임 §R5)", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({ type: "create_session", requestId: "cs-1" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "error",
      message: "Not implemented in soul-server-ts B-1: create_session",
      requestId: "cs-1",
      command_type: "create_session",
    });
  });

  it("intervene, respond, list_sessions, subscribe_events 모두 미구현 → error", async () => {
    const { dispatcher, sent } = createDispatcher();
    const commands = ["intervene", "respond", "list_sessions", "subscribe_events"];
    for (const type of commands) {
      await dispatcher.dispatch({ type, requestId: `${type}-id` });
    }
    expect(sent).toHaveLength(4);
    for (let i = 0; i < commands.length; i++) {
      const reply = sent[i] as { type: string; message: string; command_type: string };
      expect(reply.type).toBe("error");
      expect(reply.command_type).toBe(commands[i]);
      expect(reply.message).toContain("Not implemented in soul-server-ts B-1");
    }
  });

  it("type이 없는 명령은 무시 (응답 없음)", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch({ requestId: "x" });
    expect(sent).toHaveLength(0);
  });

  it("undefined/null 명령은 무시", async () => {
    const { dispatcher, sent } = createDispatcher();
    await dispatcher.dispatch(undefined);
    await dispatcher.dispatch(null);
    expect(sent).toHaveLength(0);
  });
});
