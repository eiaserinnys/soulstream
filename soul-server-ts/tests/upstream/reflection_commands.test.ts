import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import type { CatalogService } from "../../src/catalog/catalog_service.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { ReflectionCommands } from "../../src/upstream/reflection_commands.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";

function createSilentLogger() {
  const noop = () => {};
  return {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    level: "silent",
    child: () => createSilentLogger(),
  } as unknown as McpRuntime["logger"];
}

function makeRuntime(): McpRuntime {
  return {
    nodeId: "node-test",
    agentsConfigPath: "/tmp/agents.yaml",
    db: { ping: vi.fn(async () => undefined) } as unknown as SessionDB,
    taskManager: { listTasks: vi.fn(() => []) } as unknown as TaskManager,
    taskExecutor: {} as TaskExecutor,
    agentRegistry: new AgentRegistry([
      {
        id: "codex-default",
        name: "Codex",
        backend: "codex",
        workspace_dir: "/tmp/codex",
      },
    ]),
    catalogService: {} as CatalogService,
    logger: createSilentLogger(),
  };
}

describe("ReflectionCommands", () => {
  it("builds reflect_brief ACK from the same live brief builder as MCP", async () => {
    const commands = new ReflectionCommands(makeRuntime());

    const result = await commands.reflectBrief({ requestId: "req-1" });

    expect(result).toMatchObject({
      type: "reflect_brief",
      requestId: "req-1",
      ok: true,
      brief: {
        schema_version: "soulstream.reflect.v1",
        kind: "compact_aggregate",
        services: [
          expect.objectContaining({
            name: "soul-server-ts",
          }),
        ],
      },
    });
    expect(typeof result.checked_at).toBe("string");
  });

  it("fails explicitly when reflection runtime is not wired", async () => {
    const commands = new ReflectionCommands(undefined);

    await expect(commands.reflectBrief({ requestId: "req-1" })).rejects.toThrow(
      "reflection runtime is not configured",
    );
  });
});
