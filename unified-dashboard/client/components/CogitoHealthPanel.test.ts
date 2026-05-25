import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CogitoHealthPanelContent,
  type CogitoHealthPanelState,
} from "./CogitoHealthPanel";

vi.mock("@seosoyoung/soul-ui", async () => {
  const React = await import("react");
  return {
    Badge: ({ children }: { children: unknown }) =>
      React.createElement("span", null, children as never),
    Button: ({
      children,
      ...props
    }: {
      children: unknown;
      [key: string]: unknown;
    }) => React.createElement("button", props, children as never),
    cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  };
});

function render(state: CogitoHealthPanelState): string {
  return renderToStaticMarkup(
    createElement(CogitoHealthPanelContent, {
      state,
      onRefresh: () => {},
    }),
  );
}

describe("CogitoHealthPanelContent", () => {
  it("renders loading state", () => {
    expect(render({ kind: "loading" })).toContain("Checking");
  });

  it("renders endpoint error state without crashing", () => {
    const html = render({ kind: "error", message: "cogito briefs HTTP 503" });

    expect(html).toContain("Unavailable");
    expect(html).toContain("cogito briefs HTTP 503");
  });

  it("renders empty aggregate state", () => {
    const html = render({
      kind: "ready",
      summary: {
        status: "empty",
        checkedAt: "2026-05-25T12:00:00.000Z",
        nodeCount: 0,
        nodes: [],
      },
    });

    expect(html).toContain("Empty");
    expect(html).toContain("No cogito nodes");
  });

  it("renders partial aggregate and timeout node state", () => {
    const html = render({
      kind: "ready",
      summary: {
        status: "partial",
        checkedAt: "2026-05-25T12:00:00.000Z",
        nodeCount: 2,
        nodes: [
          {
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
          },
          {
            nodeId: "node-timeout",
            status: "timeout",
            serviceStatus: "timeout",
            capabilityCount: 0,
            capabilities: [],
            omittedCapabilities: 0,
            runtime: {
              status: "unavailable",
              tasksByStatus: {},
              dependencies: [],
            },
            warnings: [{ code: "node_timeout", message: "deadline exceeded" }],
          },
        ],
      },
    });

    expect(html).toContain("Partial");
    expect(html).toContain("node-ok");
    expect(html).toContain("runtime ok");
    expect(html).toContain("database:ok");
    expect(html).toContain("node-timeout");
    expect(html).toContain("Timeout");
    expect(html).toContain("node_timeout");
  });
});
