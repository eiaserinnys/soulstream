import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CogitoNodeHealthNote, CogitoNodeHealthRow } from "./CogitoHealthPanel";
import { clockLabel } from "./CogitoNodeHealthClock";
import type { CogitoNodeHealth } from "../lib/cogito-health";

vi.mock("@seosoyoung/soul-ui", async () => {
  return {
    cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  };
});

const healthyNode: CogitoNodeHealth = {
  nodeId: "node-ok",
  status: "ok",
  checkedAt: "2026-05-25T12:00:01.000Z",
  service: "soul-server-ts",
  serviceStatus: "ok",
  capabilityCount: 2,
  capabilities: ["cogito", "session_query"],
  omittedCapabilities: 0,
  runtime: {
    status: "ok",
    uptimeLabel: "5m",
    memoryLabel: "rss 120MB / heap 45MB",
    agentCount: 4,
    activeTaskCount: 1,
    tasksByStatus: { running: 1 },
    dependencies: [{ name: "database", status: "ok" }],
  },
  warnings: [],
};

const timeoutNode: CogitoNodeHealth = {
  ...healthyNode,
  status: "timeout",
  warnings: [{ code: "cogito_timeout", message: "cogito brief timed out after 8s" }],
};

const errorNode: CogitoNodeHealth = {
  ...healthyNode,
  status: "error",
};

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

describe("CogitoNodeHealthRow", () => {
  it("draws the loading expression in the row slot without a badge", () => {
    const html = render(createElement(CogitoNodeHealthNote, { state: { kind: "loading" } }));

    expect(html).toContain("Cogito");
    expect(html).toContain("Checking...");
    expect(html).not.toContain("c724-badge");
  });

  it("draws the failure line in the row slot", () => {
    const html = render(createElement(CogitoNodeHealthNote, {
      state: { kind: "error", message: "cogito briefs HTTP 503" },
    }));

    expect(html).toContain("Cogito");
    expect(html).toContain("Unavailable");
    expect(html).toContain("c724-badge c724-badge-warn");
    expect(html).toContain("c724-pool-error");
    expect(html).toContain("cogito briefs HTTP 503");
  });

  it("labels the embedded row 「Cogito」 with the neighbor dot and no badge when healthy", () => {
    const html = render(createElement(CogitoNodeHealthRow, { node: healthyNode, embedded: true }));

    expect(html).toContain(">Cogito<");
    expect(html).not.toContain(">node-ok<");
    expect(html).toContain("c724-account-row");
    expect(html).toContain("c724-status-dot");
    expect(html).not.toContain("c724-badge");
    expect(html).not.toContain(">OK<");
    expect(html).toContain("runtime ok");
    expect(html).toContain("database:ok");
  });

  it("uses the neighbor warning and danger badges for timeout and error", () => {
    const timeout = render(createElement(CogitoNodeHealthRow, { node: timeoutNode, embedded: true }));
    const error = render(createElement(CogitoNodeHealthRow, { node: errorNode, embedded: true }));

    expect(timeout).toContain("c724-badge c724-badge-warn");
    expect(timeout).toContain(">Timeout<");
    expect(timeout).toContain("cogito_timeout: cogito brief timed out after 8s");
    expect(error).toContain("c724-badge c724-badge-danger");
    expect(error).toContain(">Error<");
  });

  it("writes the checked time as the head's 24-hour HH:MM", () => {
    const html = render(createElement(CogitoNodeHealthRow, { node: healthyNode, embedded: true }));
    const expected = clockLabel(healthyNode.checkedAt ?? null);

    expect(expected).toMatch(/^\d{2}:\d{2}$/);
    expect(html).toContain(`ok / ${expected}`);
  });

  it("keeps the node name in the standalone row", () => {
    const html = render(createElement(CogitoNodeHealthRow, { node: healthyNode }));

    expect(html).toContain("node-ok");
    expect(html).toContain("runtime ok");
    expect(html).toContain("database:ok");
  });
});
