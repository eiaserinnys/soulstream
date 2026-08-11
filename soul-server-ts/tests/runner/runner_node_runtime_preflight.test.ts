import { describe, expect, it, vi } from "vitest";

import { assertRunnerNodeRuntime } from "../../src/runner/runner_node_runtime_preflight.js";

describe("runner Node runtime preflight", () => {
  it("flag off에서는 node:sqlite probe를 실행하지 않는다", async () => {
    const probeNodeSqlite = vi.fn(async () => {
      throw new Error("node:sqlite unavailable");
    });

    await expect(assertRunnerNodeRuntime({
      runnerProcessEnabled: false,
      nodeVersion: "20.19.4",
      probeNodeSqlite,
    })).resolves.toBeUndefined();
    expect(probeNodeSqlite).not.toHaveBeenCalled();
  });

  it.each(["20.19.4", "22.5.0", "22.12.0", "23.3.0"])(
    "flag on에서는 Node %s의 실제 probe 실패를 명확히 거부한다",
    async (nodeVersion) => {
      await expect(assertRunnerNodeRuntime({
        runnerProcessEnabled: true,
        nodeVersion,
        execArgv: [],
        probeNodeSqlite: async () => {
          throw new Error("ERR_UNKNOWN_BUILTIN_MODULE");
        },
      })).rejects.toThrow(
        `SOUL_RUNNER_PROCESS_ENABLED=true requires node:sqlite, but the capability probe failed on Node.js ${nodeVersion}`,
      );
    },
  );

  it.each(["22.5.0", "22.12.0", "22.13.0", "23.3.0", "23.4.0"])(
    "flag on에서는 버전과 무관하게 Node %s의 실제 probe 성공을 허용한다",
    async (nodeVersion) => {
      await expect(assertRunnerNodeRuntime({
        runnerProcessEnabled: true,
        nodeVersion,
        probeNodeSqlite: async () => ({ DatabaseSync: class {} }),
      })).resolves.toBeUndefined();
    },
  );

  it("실패 메시지는 실험 플래그와 무플래그 지원 버전을 안내한다", async () => {
    await expect(assertRunnerNodeRuntime({
      runnerProcessEnabled: true,
      nodeVersion: "22.5.0",
      execArgv: [],
      probeNodeSqlite: async () => {
        throw new Error("ERR_UNKNOWN_BUILTIN_MODULE");
      },
    })).rejects.toThrow(
      /--experimental-sqlite.*Node\.js >=22\.13\.0 or >=23\.4\.0/s,
    );
  });
});
