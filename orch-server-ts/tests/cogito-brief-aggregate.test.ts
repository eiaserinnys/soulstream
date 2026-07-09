import { describe, expect, it, vi } from "vitest";

import {
  CogitoBriefTimeoutError,
  CogitoBriefUnavailableError,
  collectCogitoBriefs,
  type CogitoBriefCollector,
  type CogitoNode,
} from "../src/index.js";

const baseNode = {
  host: "127.0.0.1",
  port: 4105,
  capabilities: { reflect_brief: true },
};

describe("Cogito brief aggregate semantics", () => {
  it("keeps ok, timeout, unavailable, error, and invalid response entries isolated", async () => {
    const nodes: CogitoNode[] = [
      { ...baseNode, id: "node-ok" },
      { ...baseNode, id: "node-timeout" },
      { ...baseNode, id: "node-unavailable" },
      { ...baseNode, id: "node-error" },
      { ...baseNode, id: "node-invalid" },
      { ...baseNode, id: "node-ignored", capabilities: {} },
    ];
    const collector: CogitoBriefCollector = {
      reflectBrief: vi.fn(async (node) => {
        if (node.id === "node-ok") {
          return { checked_at: "2026-07-09T04:00:01.000Z", brief: { ok: true } };
        }
        if (node.id === "node-timeout") {
          throw new CogitoBriefTimeoutError("slow");
        }
        if (node.id === "node-unavailable") {
          throw new CogitoBriefUnavailableError("transport closed");
        }
        if (node.id === "node-error") {
          throw new Error("node failed");
        }
        return { checked_at: "2026-07-09T04:00:05.000Z" };
      }),
    };

    await expect(
      collectCogitoBriefs(nodes, {
        collector,
        timeoutSeconds: 3.5,
        nowIso: () => "2026-07-09T04:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "partial",
      timeout_seconds: 3.5,
      node_count: 5,
      nodes: [
        {
          node_id: "node-ok",
          status: "ok",
          checked_at: "2026-07-09T04:00:01.000Z",
          data: { ok: true },
          errors: [],
        },
        {
          node_id: "node-timeout",
          status: "timeout",
          data: null,
          errors: [{ code: "node_timeout", message: "slow" }],
        },
        {
          node_id: "node-unavailable",
          status: "unavailable",
          data: null,
          errors: [{ code: "node_unavailable", message: "transport closed" }],
        },
        {
          node_id: "node-error",
          status: "error",
          data: null,
          errors: [{ code: "node_error", message: "node failed" }],
        },
        {
          node_id: "node-invalid",
          status: "error",
          data: null,
          errors: [{
            code: "invalid_reflect_brief_response",
            message: "reflect_brief response missing object field 'brief'",
          }],
        },
      ],
    });
    expect(collector.reflectBrief).toHaveBeenCalledTimes(5);
  });
});
