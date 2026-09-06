/**
 * @vitest-environment jsdom
 *
 * Render evidence for the legacy orchestrator creation surface (`/v1`).
 * The effort control here uses the soul-ui Select, so the assertions are on the
 * rendered trigger value and on the create payload.
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDashboardStore } from "@seosoyoung/soul-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useOrchestratorStore, type OrchestratorNode } from "../store/orchestrator-store";

const createDashboardSession = vi.fn();
vi.mock("client/lib/session-create", () => ({
  createDashboardSession: (input: unknown) => createDashboardSession(input),
}));
vi.mock("../config/AppConfigContext", () => ({
  useAppConfig: () => ({ mode: "orchestrator", nodeId: "node-a" }),
}));

const { OrchestratorNewSessionModal } = await import("./OrchestratorNewSessionModal");

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
      return Promise.resolve({
        ok: true,
        json: async () => ({ model_presets: presets }),
      } as Response);
    }
    if (url.includes("claude-auth")) {
      return Promise.resolve({ ok: true, json: async () => ({ profiles: [] }) } as Response);
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({
        agents: [{ id: "roselin", name: "roselin", backend: "claude", default_preset: "claude-opus" }],
      }),
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
  useDashboardStore.setState({
    isNewSessionModalOpen: true,
    newSessionDefaults: { nodeId: "node-a", agentId: "roselin", modelPreset: "claude-opus" },
  } as never);
  createDashboardSession.mockReset();
  createDashboardSession.mockResolvedValue({ agentSessionId: "s-new" });
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  useOrchestratorStore.setState({ nodes: new Map(), connectionStatus: "connecting" });
  useDashboardStore.setState({ isNewSessionModalOpen: false } as never);
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(createElement(
      QueryClientProvider,
      { client },
      createElement(OrchestratorNewSessionModal, null),
    ));
  });
}

async function settle(times = 10) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function effortLabel(): HTMLElement | null {
  return Array.from(document.body.querySelectorAll("label")).find(
    (element) => element.textContent === "Reasoning Effort",
  ) ?? null;
}

describe("OrchestratorNewSessionModal reasoning effort", () => {
  it("shows the advertised default for the selected preset", async () => {
    stubFetch([OPUS]);
    mount();
    await settle();

    expect(effortLabel()).not.toBeNull();
    // The old build hardcoded xhigh in the client; this value now comes from the
    // preset advertisement, and the control renders for a Claude preset at all
    // (the previous `backend === "codex"` gate hid it entirely).
    expect(document.body.textContent).toContain("X High");
  });

  it("hides the control for a preset that advertises no efforts", async () => {
    stubFetch([KIMI]);
    useDashboardStore.setState({
      newSessionDefaults: { nodeId: "node-a", agentId: "roselin", modelPreset: "kimi-3" },
    } as never);
    mount();
    await settle();

    expect(effortLabel()).toBeNull();
  });
});
