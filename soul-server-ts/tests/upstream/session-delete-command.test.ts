/**
 * card #1261 B — 노드의 delete_session 제어 명령.
 *
 * orch가 소유 노드에 보내는 delete_session은 노드의 기존 삭제 경로
 * (TaskManager.deleteTask)를 그대로 쓰고 delete_session_ack로 회신한다.
 * 구버전 노드는 이 명령을 모르므로 dispatcher가 기존 "Not implemented" 오류를 낸다
 * (그 판정은 orch 세션 삭제 조정자가 한다).
 */
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import { CommandDispatcher } from "../../src/upstream/dispatcher.js";

const silentLogger = pino({ level: "silent" });

function createDispatcher(deleteTask: TaskManager["deleteTask"]) {
  const sent: unknown[] = [];
  const send = vi.fn(async (data: unknown) => {
    sent.push(data);
  });
  const dispatcher = new CommandDispatcher({
    send,
    logger: silentLogger,
    nodeId: "node-test",
    agentRegistry: new AgentRegistry([{
      id: "codex-default",
      name: "Codex Default",
      backend: "codex",
      workspace_dir: "/tmp/codex-default",
    }]),
    taskManager: {
      deleteTask,
      cancelTask: vi.fn(async () => true),
      listTasks: vi.fn(() => []),
    } as unknown as TaskManager,
    taskExecutor: { startNewExecution: vi.fn() } as unknown as TaskExecutor,
  });
  return { dispatcher, sent };
}

describe("CommandDispatcher.delete_session (card #1261)", () => {
  it("기존 삭제 경로를 호출하고 delete_session_ack로 회신한다", async () => {
    const deleteTask = vi.fn(async () => true);
    const { dispatcher, sent } = createDispatcher(deleteTask);

    await dispatcher.dispatch({
      type: "delete_session",
      agentSessionId: "sess-del",
      requestId: "delete-1",
    });

    expect(deleteTask).toHaveBeenCalledWith("sess-del");
    expect(sent).toEqual([{
      type: "delete_session_ack",
      requestId: "delete-1",
      agentSessionId: "sess-del",
      status: "ok",
      deleted: true,
    }]);
  });

  it("이미 없는 세션도 idempotent ok로 회신한다", async () => {
    const deleteTask = vi.fn(async () => false);
    const { dispatcher, sent } = createDispatcher(deleteTask);

    await dispatcher.dispatch({
      type: "delete_session",
      session_id: "sess-gone",
      requestId: "delete-2",
    });

    expect(deleteTask).toHaveBeenCalledWith("sess-gone");
    expect(sent).toEqual([{
      type: "delete_session_ack",
      requestId: "delete-2",
      agentSessionId: "sess-gone",
      status: "ok",
      deleted: false,
    }]);
  });

  it("삭제 실패는 error 메시지로 회신해 orch가 타임아웃 없이 판정한다", async () => {
    const deleteTask = vi.fn(async () => {
      throw new Error("task creation projections did not drain before delete deadline");
    });
    const { dispatcher, sent } = createDispatcher(deleteTask);

    await dispatcher.dispatch({
      type: "delete_session",
      agentSessionId: "sess-busy",
      requestId: "delete-3",
    });

    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "delete-3",
      command_type: "delete_session",
    });
    expect((sent[0] as { message: string }).message).toContain("did not drain");
  });

  it("agentSessionId가 없으면 side effect 없이 오류를 낸다", async () => {
    const deleteTask = vi.fn(async () => true);
    const { dispatcher, sent } = createDispatcher(deleteTask);

    await dispatcher.dispatch({ type: "delete_session", requestId: "delete-4" });

    expect(deleteTask).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "delete-4",
    });
    expect((sent[0] as { message: string }).message).toContain("agentSessionId");
  });
});
