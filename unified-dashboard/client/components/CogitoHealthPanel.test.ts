import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CogitoNodeHealthNote, CogitoNodeHealthRow } from "./CogitoHealthPanel";
import type { CogitoNodeHealth } from "../lib/cogito-health";

vi.mock("@seosoyoung/soul-ui", async () => {
  const React = await import("react");
  return {
    Badge: ({ children }: { children: unknown }) =>
      React.createElement("span", null, children as never),
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

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

describe("CogitoNodeHealthRow", () => {
  it("draws the loading expression in the row slot", () => {
    const html = render(createElement(CogitoNodeHealthNote, { state: { kind: "loading" } }));

    expect(html).toContain("Cogito");
    expect(html).toContain("Checking");
  });

  it("draws the failure line in the row slot", () => {
    const html = render(createElement(CogitoNodeHealthNote, {
      state: { kind: "error", message: "cogito briefs HTTP 503" },
    }));

    expect(html).toContain("Cogito");
    expect(html).toContain("Unavailable");
    expect(html).toContain("cogito briefs HTTP 503");
  });

  it("labels the embedded row 「Cogito」 instead of repeating the node name", () => {
    const html = render(createElement(CogitoNodeHealthRow, { node: healthyNode, embedded: true }));

    expect(html).toContain(">Cogito<");
    expect(html).not.toContain(">node-ok<");
    expect(html).toContain("c724-account-row");
    expect(html).toContain("OK");
    expect(html).toContain("runtime ok");
    expect(html).toContain("database:ok");
  });

  it("keeps the node name in the standalone row", () => {
    const html = render(createElement(CogitoNodeHealthRow, { node: healthyNode }));

    expect(html).toContain("node-ok");
    expect(html).toContain("runtime ok");
    expect(html).toContain("database:ok");
  });
});
