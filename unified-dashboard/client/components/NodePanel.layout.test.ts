/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOrchestratorStore, type OrchestratorNode } from "../store/orchestrator-store";

vi.mock("@seosoyoung/soul-ui", async () => {
  const React = await import("react");
  return {
    cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
    nodeIdToHue: () => 220,
    useTheme: () => ["dark"],
    ScrollArea: ({
      children,
      className,
      ...props
    }: {
      children: unknown;
      className?: string;
      [key: string]: unknown;
    }) => React.createElement("div", { className, ...props }, children as never),
  };
});

vi.mock("./CogitoHealthPanel", async () => {
  const React = await import("react");
  return {
    CogitoHealthPanel: () =>
      React.createElement("section", { "data-testid": "cogito-health-panel" }, "Cogito"),
  };
});

vi.mock("./NodeClaudeAuthPanel", async () => {
  const React = await import("react");
  return {
    NodeClaudeAuthPanel: ({ nodeId }: { nodeId: string }) =>
      React.createElement("div", { "data-testid": "node-auth-panel" }, nodeId),
  };
});

import { NodePanel } from "./NodePanel";

function node(nodeId: string): OrchestratorNode {
  return {
    nodeId,
    host: "localhost",
    port: 4105,
    status: "connected",
    capabilities: {},
    connectedAt: Date.now(),
    sessionCount: 0,
  };
}

describe("NodePanel layout", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    useOrchestratorStore.getState().setNodes([
      node("eiaserinnys"),
      node("eias-linegames"),
      node("eias-linegames-wsl"),
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    container?.remove();
    useOrchestratorStore.getState().setNodes([]);
    root = undefined;
    container = undefined;
  });

  it("keeps cogito and node cards inside one scroll surface with separated cards", () => {
    flushSync(() => {
      root?.render(createElement(NodePanel));
    });

    const scroll = container?.querySelector<HTMLElement>('[data-testid="node-panel-scroll"]');
    expect(scroll).not.toBeNull();
    expect(scroll?.className).toContain("flex-1");
    expect(scroll?.className).toContain("min-h-0");

    const body = container?.querySelector<HTMLElement>('[data-testid="node-panel-scroll-body"]');
    expect(body).not.toBeNull();
    expect(body?.className).toContain("space-y-2");
    expect(body?.className).toContain("p-2");

    const cogito = container?.querySelector<HTMLElement>('[data-testid="cogito-health-panel"]');
    const list = container?.querySelector<HTMLElement>('[data-testid="node-card-list"]');
    expect(cogito).not.toBeNull();
    expect(list).not.toBeNull();
    expect(body?.children[0]).toBe(cogito);
    expect(body?.children[1]).toBe(list);
    expect(list?.className).toContain("space-y-2");

    const cards = Array.from(container?.querySelectorAll<HTMLElement>('[data-testid="node-card"]') ?? []);
    expect(cards).toHaveLength(3);
    expect(cards[0]?.className).toContain("rounded-[13px]");
    expect(cards[0]?.className.split(/\s+/)).not.toContain("border-b");
  });
});
