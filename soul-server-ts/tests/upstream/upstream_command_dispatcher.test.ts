import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import type { ProviderUsageCommandHandler, ProviderUsageResponse } from "../../src/auth/provider_usage.js";
import type { TaskExecutor } from "../../src/task/task_executor.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import { createUpstreamCommandDispatcher } from "../../src/upstream/upstream_command_dispatcher.js";

describe("upstream command dispatcher composition", () => {
  it("routes provider_usage_get to the injected usage handler", async () => {
    const response: ProviderUsageResponse = {
      type: "provider_usage_get",
      requestId: "usage-antigravity",
      success: true,
    };
    const providerUsage: ProviderUsageCommandHandler = {
      fetchUsage: vi.fn(async () => response),
    };
    const send = vi.fn(async () => undefined);
    const dispatcher = createUpstreamCommandDispatcher({
      send,
      logger: pino({ level: "silent" }),
      nodeId: "node-a",
      dependencies: {
        agentRegistry: new AgentRegistry([]),
        taskManager: {} as TaskManager,
        taskExecutor: {} as TaskExecutor,
        providerUsage,
      },
      listRunningSessionIds: async () => [],
    });

    await dispatcher.dispatch({
      type: "provider_usage_get",
      requestId: "usage-antigravity",
      provider: "antigravity",
    });

    expect(providerUsage.fetchUsage).toHaveBeenCalledTimes(1);
    expect(providerUsage.fetchUsage).toHaveBeenCalledWith(
      "usage-antigravity", "provider_usage_get", "antigravity",
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(response);
  });
});
