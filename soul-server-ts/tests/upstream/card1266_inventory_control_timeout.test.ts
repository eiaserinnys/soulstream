import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  boundedResultTimeoutMs,
  LIST_RUNNER_INVENTORY_CONTROL_TIMEOUT_MS,
} from "../../src/upstream/control_command_inventory.js";

/**
 * 카드 #1266 U6 결함 3. orch는 list_runner_inventory에 90초를 주고 control이 붙어 있으면
 * control로 보낸다. 노드의 control 제한이 14.5초이면 스캔이 14.5초를 넘길 때마다 control
 * 재시도가 구조적으로 실패한다. 노드 제한은 orch 시한보다 짧아야 하고(오류 프레임이 시한
 * 안에 닿도록), 사용량 명령의 14.5초에 묶여 있으면 안 된다.
 */

// orch-server-ts/src/node/node_timeouts.ts RUNNER_INVENTORY_COMMAND_TIMEOUT_MS의 사본이다.
// 아래 시험이 원본 파일이 있으면 같은 값인지 대조한다.
const ORCH_RUNNER_INVENTORY_COMMAND_TIMEOUT_MS = 90_000;

describe("card #1266 U6 list_runner_inventory control timeout", () => {
  it("is the node's explicit value and no longer the usage commands' 14.5s", () => {
    expect(LIST_RUNNER_INVENTORY_CONTROL_TIMEOUT_MS).toBe(85_000);
    expect(boundedResultTimeoutMs("list_runner_inventory", 900)).toBe(85_000);
    expect(boundedResultTimeoutMs("provider_usage_get", 900)).toBe(14_500);
  });

  it("stays below orch's own limit with room for the error frame to arrive", () => {
    const timeoutMs = boundedResultTimeoutMs("list_runner_inventory", 900);
    expect(timeoutMs).toBeLessThan(ORCH_RUNNER_INVENTORY_COMMAND_TIMEOUT_MS);
    expect(ORCH_RUNNER_INVENTORY_COMMAND_TIMEOUT_MS - timeoutMs).toBeGreaterThanOrEqual(2_000);
  });

  it("matches orch's constant while the orch source is in the same checkout", () => {
    const orchSource = fileURLToPath(
      new URL("../../../orch-server-ts/src/node/node_timeouts.ts", import.meta.url),
    );
    if (!existsSync(orchSource)) return;
    const match = /RUNNER_INVENTORY_COMMAND_TIMEOUT_MS\s*=\s*([\d_]+)/.exec(
      readFileSync(orchSource, "utf8"),
    );
    expect(match).not.toBeNull();
    expect(Number(match![1]!.replaceAll("_", ""))).toBe(ORCH_RUNNER_INVENTORY_COMMAND_TIMEOUT_MS);
  });
});
