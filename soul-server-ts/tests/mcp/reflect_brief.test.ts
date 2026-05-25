import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import { buildBriefSnapshot } from "../../src/mcp/reflection/self_reflection.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";

const tempDirs: string[] = [];

function tempAgentsConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soul-reflect-brief-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "agents.yaml");
  fs.writeFileSync(
    configPath,
    [
      "agents:",
      "  - id: codex-default",
      "    name: Codex",
      "    backend: codex",
      "    workspace_dir: /tmp/codex-ws",
      "",
    ].join("\n"),
    "utf-8",
  );
  return configPath;
}

function createLogger() {
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
    child: () => createLogger(),
  } as unknown as McpRuntime["logger"];
}

function makeRuntime(overrides: Partial<McpRuntime> = {}): McpRuntime {
  return {
    nodeId: "test-node",
    agentsConfigPath: tempAgentsConfig(),
    db: {
      ping: vi.fn().mockResolvedValue(undefined),
    } as unknown as McpRuntime["db"],
    taskManager: {
      listTasks: () => [],
      getTask: () => undefined,
    } as unknown as McpRuntime["taskManager"],
    taskExecutor: {} as McpRuntime["taskExecutor"],
    agentRegistry: new AgentRegistry([
      {
        id: "codex-default",
        name: "Codex",
        backend: "codex",
        workspace_dir: "/tmp/codex-ws",
      },
    ]),
    catalogService: {} as McpRuntime["catalogService"],
    logger: createLogger(),
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildBriefSnapshot", () => {
  it("isolates a Level 3 failure into the runtime section", async () => {
    const runtime = makeRuntime({
      taskManager: {
        listTasks: () => {
          throw new Error("task manager unavailable");
        },
        getTask: () => undefined,
      } as unknown as McpRuntime["taskManager"],
    });

    const brief = await buildBriefSnapshot(runtime);
    const service = brief.services[0]?.data;

    expect(brief.status).toBe("partial");
    expect(service?.status).toBe("partial");
    expect(service?.sections.identity.status).toBe("ok");
    expect(service?.sections.configuration.status).toBe("ok");
    expect(service?.sections.source.status).toBe("ok");
    expect(service?.sections.runtime.status).toBe("unavailable");
    expect(service?.sections.runtime.errors[0]).toEqual(
      expect.objectContaining({
        code: "level_3_unavailable",
        message: "reflect_service level 3 failed",
      }),
    );
  });

  it("represents unavailable runtime dependencies structurally", async () => {
    const runtime = makeRuntime({
      db: {} as McpRuntime["db"],
    });

    const brief = await buildBriefSnapshot(runtime);
    const runtimeSection = brief.services[0]?.data.sections.runtime;

    expect(brief.status).toBe("partial");
    expect(runtimeSection?.status).toBe("partial");
    expect(runtimeSection?.data.dependencies.database.status).toBe("unavailable");
    expect(runtimeSection?.data.dependencies.database.checked_at).toEqual(expect.any(String));
    expect(runtimeSection?.errors[0]).toEqual(
      expect.objectContaining({
        code: "database_unavailable",
      }),
    );
  });
});
