/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageSummarySnapshot } from "@seosoyoung/soul-ui";
import type { OrchestratorNode } from "../store/orchestrator-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  retry: vi.fn(),
  usage: vi.fn(),
  summary: null as UsageSummarySnapshot | null,
  panel: vi.fn(),
}));

vi.mock("@seosoyoung/soul-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seosoyoung/soul-ui")>();
  return { ...actual, useAuth: () => ({ user: { email: "admin@example.com", isAdmin: true } }) };
});
vi.mock("../hooks/useUsageSummary", () => ({
  useUsageSummary: (options: unknown) => {
    mocks.usage(options);
    return { summary: mocks.summary, node: null, gauges: [], loading: false, loadState: "ready", evaluatedAtMs: 0, retry: mocks.retry };
  },
}));
vi.mock("./NodeProvidersPanel", () => ({
  NodeProvidersPanel: (props: { nodeId: string; node: { nodeId: string } | null; onUsageChanged?: () => void }) => {
    mocks.panel(props);
    return <div data-testid="providers-stub" data-node={props.nodeId} data-has-usage={String(props.node !== null)}><button type="button" onClick={props.onUsageChanged}>사용량 다시 읽기</button></div>;
  },
}));

import { CodingAgentsTab } from "./CodingAgentsTab";

const node = (nodeId: string, status: "connected" | "disconnected" = "connected"): OrchestratorNode => ({ nodeId, status } as OrchestratorNode);
const nodes = (...list: OrchestratorNode[]) => new Map(list.map((item) => [item.nodeId, item]));
const snapshot = (...ids: string[]): UsageSummarySnapshot => ({
  generatedAt: "2026-11-24T00:00:00.000Z",
  collectedAt: null,
  nodes: ids.map((nodeId) => ({ nodeId, fetchedAt: null, stale: false, staleSince: null, providers: { claude: null, codex: null, antigravity: null, opencode_go: null } })),
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.summary = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const render = async (sample: Map<string, OrchestratorNode>) => act(async () => root.render(<CodingAgentsTab sampleNodes={sample} request={vi.fn() as unknown as typeof fetch} />));
const rows = () => [...host.querySelectorAll<HTMLButtonElement>("aside button")];

describe("CodingAgentsTab", () => {
  it("opens with the only node already selected and shows its provider rows", async () => {
    mocks.summary = snapshot("solo");
    await render(nodes(node("solo")));
    expect(rows().map((row) => row.textContent)).toEqual(["solo연결됨"]);
    const panel = host.querySelector('[data-testid="providers-stub"]')!;
    expect(panel.getAttribute("data-node")).toBe("solo");
    expect(panel.getAttribute("data-has-usage")).toBe("true");
    expect(host.querySelector('[data-testid="coding-agents-pick-node"]')).toBeNull();
  });

  it("asks to pick a node when there are several, then follows the selection", async () => {
    mocks.summary = snapshot("a", "b");
    await render(nodes(node("a"), node("b")));
    expect(host.querySelector('[data-testid="coding-agents-pick-node"]')?.textContent).toContain("노드를 고르세요");
    expect(host.querySelector('[data-testid="providers-stub"]')).toBeNull();
    expect(mocks.usage.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false, nodeId: null });
    await act(async () => rows()[1]!.click());
    expect(host.querySelector('[data-testid="providers-stub"]')?.getAttribute("data-node")).toBe("b");
    expect(mocks.usage.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: true, nodeId: "b", selectedNodeId: "b" });
  });

  it("does not fall back to another node's usage when the selected node has none", async () => {
    mocks.summary = snapshot("other");
    await render(nodes(node("solo")));
    expect(host.querySelector('[data-testid="providers-stub"]')?.getAttribute("data-has-usage")).toBe("false");
  });

  it("re-reads the usage summary when a login finishes", async () => {
    mocks.summary = snapshot("solo");
    await render(nodes(node("solo")));
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "사용량 다시 읽기")!.click());
    expect(mocks.retry).toHaveBeenCalledTimes(1);
  });

  it("explains a disconnected node instead of offering logins", async () => {
    await render(nodes(node("down", "disconnected")));
    expect(rows().map((row) => row.textContent)).toEqual(["down연결 끊김"]);
    expect(host.querySelector('[data-testid="providers-stub"]')).toBeNull();
    expect(host.textContent).toContain("노드가 연결되어 있지 않아 로그인할 수 없습니다.");
  });

  it("says there are no nodes", async () => {
    await render(nodes());
    expect(host.textContent).toContain("연결된 노드가 없습니다.");
  });
});
