import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import type { ProviderUsageCommandHandler } from "../../src/auth/provider_usage.js";
import { NodeGitServiceError } from "../../src/node_git/node_git_validation.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import type { NodeGitCommandHandler } from "../../src/upstream/node_git_commands.js";
import { createUpstreamCommandDispatcher } from "../../src/upstream/upstream_command_dispatcher.js";

const snapshot = {
  identity: { name: null, email: null },
  ssh: { state: "missing", key_path: "/h/.ssh/id_ed25519", public_key: null },
  projects: { state: "root_unset", root: null, repos: [] },
  clone: null,
};
const job = {
  clone_id: "c1", repo_name: "b", url: "git@github.com:a/b.git", state: "running",
  error: null, started_at: "2026-11-27T00:00:00.000Z", finished_at: null,
};
const sshResult = { host: "github.com", ok: true, reason: "connected", output: "Hi x!" };

function setup(withService = true) {
  const handler = {
    status: vi.fn(async () => snapshot),
    setIdentity: vi.fn(async () => snapshot),
    createSshKey: vi.fn(async () => snapshot),
    checkSsh: vi.fn(async () => sshResult),
    startClone: vi.fn(async () => job),
    cloneStatus: vi.fn(() => job),
  } as unknown as NodeGitCommandHandler;
  const sent: unknown[] = [];
  const dispatcher = createUpstreamCommandDispatcher({
    send: vi.fn(async (message: unknown) => { sent.push(message); }) as never,
    logger: pino({ level: "silent" }),
    nodeId: "node-a",
    dependencies: {
      agentRegistry: new AgentRegistry([]),
      taskManager: {} as TaskManager,
      taskExecutor: {} as TaskExecutor,
      providerUsage: { fetchUsage: vi.fn() } as unknown as ProviderUsageCommandHandler,
      ...(withService ? { nodeGitService: handler } : {}),
    },
    listRunningSessionIds: async () => [],
  });
  return { dispatcher, handler, sent };
}

describe("node_git_* 명령", () => {
  it("여섯 명령이 서비스로 가고 응답은 type, requestId, success, data 꼴이다", async () => {
    const { dispatcher, handler, sent } = setup();

    await dispatcher.dispatch({ type: "node_git_status", requestId: "r1" });
    await dispatcher.dispatch({ type: "node_git_identity_set", requestId: "r2", name: "n", email: "n@e.com" });
    await dispatcher.dispatch({ type: "node_git_ssh_key_create", requestId: "r3" });
    await dispatcher.dispatch({ type: "node_git_ssh_check", requestId: "r4", host: "github.com" });
    await dispatcher.dispatch({ type: "node_git_clone_start", requestId: "r5", url: job.url, repo_name: "b" });
    await dispatcher.dispatch({ type: "node_git_clone_status", requestId: "r6", clone_id: "c1" });

    expect(handler.setIdentity).toHaveBeenCalledWith({ name: "n", email: "n@e.com" });
    expect(handler.checkSsh).toHaveBeenCalledWith({ host: "github.com" });
    expect(handler.startClone).toHaveBeenCalledWith({ url: job.url, repo_name: "b" });
    expect(handler.cloneStatus).toHaveBeenCalledWith({ clone_id: "c1" });
    expect(sent).toEqual([
      { type: "node_git_status", requestId: "r1", success: true, data: snapshot },
      { type: "node_git_identity_set", requestId: "r2", success: true, data: snapshot },
      { type: "node_git_ssh_key_create", requestId: "r3", success: true, data: snapshot },
      { type: "node_git_ssh_check", requestId: "r4", success: true, data: sshResult },
      { type: "node_git_clone_start", requestId: "r5", success: true, data: job },
      { type: "node_git_clone_status", requestId: "r6", success: true, data: job },
    ]);
  });

  it("서비스의 거절은 error(code, message, field)로 돌려주고 그 밖의 예외는 고정 오류로 감춘다", async () => {
    const { dispatcher, handler, sent } = setup();
    vi.mocked(handler.setIdentity).mockRejectedValueOnce(
      new NodeGitServiceError("invalid_request", "email is not a valid address", "email"),
    );
    vi.mocked(handler.status).mockRejectedValueOnce(new Error("/home/secret/path exploded"));

    await dispatcher.dispatch({ type: "node_git_identity_set", requestId: "r1", name: "n", email: "x" });
    await dispatcher.dispatch({ type: "node_git_status", requestId: "r2" });

    expect(sent).toEqual([
      {
        type: "node_git_identity_set", requestId: "r1", success: false,
        error: { code: "invalid_request", message: "email is not a valid address", field: "email" },
      },
      {
        type: "node_git_status", requestId: "r2", success: false,
        error: { code: "node_git_failed", message: "Node git command failed" },
      },
    ]);
  });

  it("서비스가 연결되지 않았으면 디스패처 오류를 낸다", async () => {
    const { dispatcher, sent } = setup(false);
    await dispatcher.dispatch({ type: "node_git_status", requestId: "r1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ requestId: "r1" });
    expect(JSON.stringify(sent[0])).toContain("Node git service is not configured");
    expect(sent[0]).not.toHaveProperty("success", true);
  });
});
