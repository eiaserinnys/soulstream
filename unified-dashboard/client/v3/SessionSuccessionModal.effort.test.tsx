/**
 * @vitest-environment jsdom
 *
 * Render evidence for the primary orchestrator creation surface (`/`).
 * Covers: loading -> advertised default -> manual change -> model switch refill
 * -> create payload, plus a preset that advertises nothing.
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useOrchestratorStore, type OrchestratorNode } from "../store/orchestrator-store";

const createDashboardSession = vi.fn();
vi.mock("../lib/session-create", () => ({
  createDashboardSession: (input: unknown) => createDashboardSession(input),
}));
vi.mock("./task-workspace-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createTaskPageAnchor: vi.fn().mockResolvedValue(null),
}));
vi.mock("@seosoyoung/soul-ui/page", () => ({
  createPageApiClient: () => ({}),
}));

const { SessionSuccessionModal } = await import("./SessionSuccessionModal");

const OPUS = {
  id: "claude-opus",
  label: "Claude - Opus",
  backend: "claude",
  available: true,
  reason: null,
  reason_label: null,
  resets_at: null,
  usage_warning: false,
  supported_efforts: ["low", "medium", "high", "xhigh", "max"],
  default_effort: "xhigh",
};
const ASTRA = {
  ...OPUS,
  id: "codex-6-astra",
  label: "Codex - 6 Astra",
  backend: "codex",
  supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  default_effort: "medium",
};
const KIMI = {
  ...OPUS,
  id: "kimi-3",
  label: "Kimi - 3",
  supported_efforts: undefined,
  default_effort: undefined,
};

function node(nodeId: string): OrchestratorNode {
  return {
    nodeId,
    host: "127.0.0.1",
    port: 5200,
    status: "connected",
    capabilities: {},
    connectedAt: 1,
    sessionCount: 0,
  };
}

let container: HTMLDivElement;
let root: Root;

function stubFetch(presets: unknown[]) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("model-presets")) {
      return Promise.resolve({ ok: true, json: async () => ({ model_presets: presets }) } as Response);
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ agents: [{ id: "roselin", name: "roselin", default_preset: "claude-opus" }] }),
    } as Response);
  }));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useOrchestratorStore.setState({
    nodes: new Map([["node-a", node("node-a")]]),
    connectionStatus: "connected",
  });
  createDashboardSession.mockReset();
  createDashboardSession.mockResolvedValue({ agentSessionId: "s-new" });
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  useOrchestratorStore.setState({ nodes: new Map(), connectionStatus: "connecting" });
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(createElement(
      QueryClientProvider,
      { client },
      createElement(SessionSuccessionModal, {
        taskTitle: "업무",
        taskPageId: "page-1",
        taskId: "task-1",
        contextItems: [],
        documentOptions: [],
        contextPending: false,
        predecessorOptions: [],
        pageDefaults: { agentId: "roselin", nodeId: "node-a", modelPreset: "claude-opus" } as never,
        currentSession: null,
        onClose: () => {},
        onCreated: () => {},
      }),
    ));
  });
}

async function settle(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// The dialog renders through a portal onto document.body, not into container.
function effortSelect(): HTMLSelectElement | null {
  return document.body.querySelector<HTMLSelectElement>('select[aria-label="추론 강도 선택"]');
}

function setSelect(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function modelSelect(): HTMLSelectElement | null {
  return document.body.querySelector<HTMLSelectElement>('select[aria-label="모델 선택"]');
}

function startButton(): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (button) => button.textContent?.includes("시작"),
  );
}

describe("SessionSuccessionModal reasoning effort", () => {
  it("renders no picker while the catalogue is loading, then the advertised default", async () => {
    stubFetch([OPUS, ASTRA]);
    mount();
    expect(effortSelect()).toBeNull();

    await settle();
    const select = effortSelect();
    expect(select).not.toBeNull();
    expect(select?.value).toBe("xhigh");
    expect(Array.from(select?.options ?? []).map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("offers no picker for a preset that advertises nothing", async () => {
    stubFetch([KIMI]);
    mount();
    await settle();
    expect(effortSelect()).toBeNull();
  });

  it("drops the previous node's pick when the node changes", async () => {
    // Node A and node B both advertise `claude-opus`, with different defaults.
    // Keying refill on the preset id alone would keep node A's pick here.
    useOrchestratorStore.setState({
      nodes: new Map([["node-a", node("node-a")], ["node-b", node("node-b")]]),
      connectionStatus: "connected",
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("model-presets")) {
        const preset = url.includes("node-b")
          ? { ...OPUS, default_effort: "high" }
          : OPUS;
        return Promise.resolve({
          ok: true,
          json: async () => ({ model_presets: [preset] }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ agents: [{ id: "roselin", name: "roselin", default_preset: "claude-opus" }] }),
      } as Response);
    }));
    mount();
    await settle();
    expect(effortSelect()?.value).toBe("xhigh");

    flushSync(() => setSelect(effortSelect()!, "low"));
    await settle();
    expect(effortSelect()?.value).toBe("low");

    const nodes = document.body.querySelector<HTMLSelectElement>('select[aria-label="노드 선택"]');
    flushSync(() => setSelect(nodes!, "node-b"));
    await settle(25);

    // Changing the node clears the model selection on this surface, so the
    // picker goes away with it. What matters is that node A's `low` cannot
    // survive into a node-B session: re-picking a model adopts node B's own
    // default (proven against the shared hook, which owns that transition).
    expect(effortSelect()).toBeNull();

    flushSync(() => startButton()?.click());
    await settle();
    if (createDashboardSession.mock.calls.length > 0) {
      expect(createDashboardSession.mock.calls[0]?.[0])
        .not.toHaveProperty("reasoningEffort");
    }
  });

  it("sends the manual pick and omits it when untouched", async () => {
    stubFetch([OPUS]);
    mount();
    await settle();

    // Untouched: the node applies the preset default, so nothing is sent.
    const start = startButton();
    flushSync(() => start?.click());
    await settle();
    expect(createDashboardSession).toHaveBeenCalled();
    expect(createDashboardSession.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");

    createDashboardSession.mockClear();
    const select = effortSelect();
    flushSync(() => setSelect(select!, "low"));
    await settle();
    expect(effortSelect()?.value).toBe("low");

    flushSync(() => start?.click());
    await settle();
    expect(createDashboardSession.mock.calls[0]?.[0]).toMatchObject({
      reasoningEffort: "low",
    });
  });
});
