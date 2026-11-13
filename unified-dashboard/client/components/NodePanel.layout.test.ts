/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOrchestratorStore, type OrchestratorNode } from "../store/orchestrator-store";

vi.mock("@seosoyoung/soul-ui", async () => {
  const React = await import("react");
  const usage = await import("../../../packages/soul-ui/src/lib/usage-summary");
  return {
    ...usage,
    DashboardIconCap: ({ label, ...props }: { label?: string; [key: string]: unknown }) =>
      React.createElement("button", { type: "button", "aria-label": label, ...props }),
    cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
    nodeIdToHue: () => 220,
    useTheme: () => ["dark"],
  };
});

vi.mock("./CogitoHealthPanel", async () => {
  const React = await import("react");
  const Stub = () => React.createElement("div");
  return { CogitoNodeHealthRow: Stub, CogitoNodeHealthNote: Stub };
});

vi.mock("./NodeProvidersPanel", async () => {
  const React = await import("react");
  return {
    NodeProvidersPanel: ({ nodeId }: { nodeId: string }) =>
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

  it("lays the node cards out in the settings flow without owning a nested scroll surface", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root?.render(createElement(QueryClientProvider, { client }, createElement(NodePanel)));
    });

    // NodePanel은 스크롤을 직접 만들지 않는다. 스크롤은 바깥 설정 상세 영역 하나가 맡는다.
    expect(container?.querySelector('[data-testid="node-panel-scroll"]')).toBeNull();
    const body = container?.querySelector<HTMLElement>('[data-testid="node-panel-body"]');
    expect(body).not.toBeNull();
    expect(body?.className).toContain("space-y-2");
    // 안쪽 여백은 설정 구역 틀(.config-detail)이 가진다. 몸통이 다시 더하면 제목 시작선보다 안쪽에서 시작한다.
    expect(body?.className).not.toMatch(/(^|\s)p[xylrtb]?-\d/);

    // cogito는 목록 위 별도 카드가 아니라 펼친 노드 안에 있다.
    expect(container?.querySelector('[data-testid="cogito-health-panel"]')).toBeNull();

    const list = container?.querySelector<HTMLElement>('[data-testid="node-card-list"]');
    expect(list).not.toBeNull();
    expect(list?.parentElement).toBe(body);
    expect(list?.className).toContain("space-y-2");

    const cards = Array.from(container?.querySelectorAll<HTMLElement>('[data-testid="node-card"]') ?? []);
    expect(cards).toHaveLength(3);
    expect(cards[0]?.className).toContain("rounded-[13px]");
    expect(cards[0]?.className.split(/\s+/)).not.toContain("border-b");
  });
});
