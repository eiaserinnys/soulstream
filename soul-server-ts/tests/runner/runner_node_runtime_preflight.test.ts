import { describe, expect, it } from "vitest";

import { assertRunnerNodeRuntime } from "../../src/runner/runner_node_runtime_preflight.js";

describe("runner Node runtime preflight", () => {
  it("flag off에서는 node:sqlite가 없는 Node 20을 허용한다", () => {
    expect(() => assertRunnerNodeRuntime({
      runnerProcessEnabled: false,
      nodeVersion: "20.19.4",
    })).not.toThrow();
  });

  it.each(["20.19.4", "22.4.1", "22.4.99"])(
    "flag on에서는 Node %s를 명확히 거부한다",
    (nodeVersion) => {
      expect(() => assertRunnerNodeRuntime({
        runnerProcessEnabled: true,
        nodeVersion,
      })).toThrow(
        `SOUL_RUNNER_PROCESS_ENABLED=true requires Node.js >=22.5.0 for node:sqlite; current ${nodeVersion}`,
      );
    },
  );

  it.each(["22.5.0", "22.5.1", "23.0.0"])(
    "flag on에서는 Node %s를 허용한다",
    (nodeVersion) => {
      expect(() => assertRunnerNodeRuntime({
        runnerProcessEnabled: true,
        nodeVersion,
      })).not.toThrow();
    },
  );

  it("파싱 불가능한 Node 버전은 flag on에서 거부한다", () => {
    expect(() => assertRunnerNodeRuntime({
      runnerProcessEnabled: true,
      nodeVersion: "unknown",
    })).toThrow(/could not parse current Node.js version/);
  });
});
