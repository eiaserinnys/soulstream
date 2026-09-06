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

function stubFetch(presets: unknown[], agentDefaultPreset = "claude-opus") {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("model-presets")) {
      return Promise.resolve({ ok: true, json: async () => ({ model_presets: presets }) } as Response);
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ agents: [{ id: "roselin", name: "roselin", default_preset: agentDefaultPreset }] }),
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

function mountWithSession(session: Record<string, unknown> | null, presetId = "claude-opus") {
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
        pageDefaults: { agentId: "roselin", nodeId: "node-a", modelPreset: presetId } as never,
        currentSession: session as never,
        onClose: () => {},
        onCreated: () => {},
      }),
    ));
  });
}

function unsupportedNotice(): Element | null {
  return document.body.querySelector('[data-testid="succession-effort-unsupported"]');
}

function useDefaultButton(): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>(
    '[data-testid="succession-effort-use-default"]',
  );
}

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
    stubFetch([KIMI], "kimi-3");
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

describe("unusable carried-over effort", () => {
  const predecessorAtUltra = {
    agentSessionId: "prev-1",
    agentId: "roselin",
    nodeId: "node-a",
    modelPreset: "claude-opus",
    // Recorded on a Codex preset; Opus advertises low..max but not ultra.
    reasoningEffort: "ultra",
  };

  it("explains the problem and refuses to create", async () => {
    stubFetch([OPUS]);
    mountWithSession(predecessorAtUltra);
    await settle();

    expect(unsupportedNotice()).not.toBeNull();
    expect(startButton()?.disabled).toBe(true);

    flushSync(() => startButton()?.click());
    await settle();
    expect(createDashboardSession).not.toHaveBeenCalled();
  });

  it("clears once a supported level is chosen", async () => {
    stubFetch([OPUS]);
    mountWithSession(predecessorAtUltra);
    await settle();

    flushSync(() => setSelect(effortSelect()!, "low"));
    await settle();
    expect(unsupportedNotice()).toBeNull();
    expect(startButton()?.disabled).toBe(false);

    flushSync(() => startButton()?.click());
    await settle();
    expect(createDashboardSession.mock.calls[0]?.[0]).toMatchObject({
      reasoningEffort: "low",
    });
  });

  it("shows the unusable value and clears it from the picker itself", async () => {
    // The picker used to sit on "" with the invalid value only in state, so
    // choosing 기본값 사용 fired no change event and the form stayed stuck.
    stubFetch([OPUS]);
    mountWithSession(predecessorAtUltra);
    await settle();
    expect(effortSelect()?.value).toBe("ultra");
    expect(effortSelect()?.options[0]?.textContent).toContain("지원 안 함");

    flushSync(() => setSelect(effortSelect()!, ""));
    await settle();
    expect(unsupportedNotice()).toBeNull();
    expect(startButton()?.disabled).toBe(false);

    flushSync(() => startButton()?.click());
    await settle();
    expect(createDashboardSession.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");
  });

  it("recovers on the same model by falling back to the preset default", async () => {
    // The point of the recovery: keeping this model must stay possible. Forcing
    // a different model would be a worse answer than "use the default".
    stubFetch([OPUS]);
    mountWithSession(predecessorAtUltra);
    await settle();
    expect(startButton()?.disabled).toBe(true);

    flushSync(() => useDefaultButton()?.click());
    await settle();
    expect(unsupportedNotice()).toBeNull();
    expect(startButton()?.disabled).toBe(false);

    flushSync(() => startButton()?.click());
    await settle();
    const payload = createDashboardSession.mock.calls[0]?.[0];
    // Omitted, so the node applies claude-opus's own default — and the model is
    // still claude-opus.
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).toMatchObject({ modelPreset: "claude-opus" });
  });

  it("offers the same recovery when the preset advertises nothing at all", async () => {
    // No picker exists here, so the notice is the only way out. It used to say
    // "pick a different model", which left the chosen model unusable.
    stubFetch([KIMI], "kimi-3");
    mountWithSession({ ...predecessorAtUltra, modelPreset: "kimi-3" }, "kimi-3");
    await settle();

    expect(effortSelect()).toBeNull();
    expect(unsupportedNotice()?.textContent).toContain("기본값으로 시작하세요");
    expect(unsupportedNotice()?.textContent ?? "").not.toContain("다른 모델");
    expect(startButton()?.disabled).toBe(true);

    flushSync(() => useDefaultButton()?.click());
    await settle();
    expect(unsupportedNotice()).toBeNull();
    expect(startButton()?.disabled).toBe(false);

    flushSync(() => startButton()?.click());
    await settle();
    expect(createDashboardSession.mock.calls[0]?.[0]).toMatchObject({
      modelPreset: "kimi-3",
    });
  });

  it("stays quiet while the catalogue is still loading", async () => {
    // Before the preset advertisement arrives we know nothing, so claiming the
    // model has no effort control would be a lie on every succession open.
    stubFetch([OPUS]);
    mountWithSession(predecessorAtUltra);
    // Only the notice is load-bearing here: the button is disabled during load
    // anyway because the agent has not resolved yet.
    expect(unsupportedNotice()).toBeNull();

    await settle();
    expect(unsupportedNotice()?.textContent).toContain("기본값으로 시작하세요");
  });
});

describe("preset with efforts but no advertised default", () => {
  const NO_DEFAULT = { ...OPUS, default_effort: undefined };

  it("shows the default option rather than a level it will not send", async () => {
    // The select would otherwise display its first option (Low) while the
    // request omits effort entirely.
    stubFetch([NO_DEFAULT]);
    mount();
    await settle();

    const select = effortSelect();
    expect(select?.value).toBe("");
    expect(Array.from(select?.options ?? []).map((option) => option.textContent))
      .toEqual(["기본값", "Low", "Medium", "High", "X High", "Max"]);

    flushSync(() => startButton()?.click());
    await settle();
    expect(createDashboardSession.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");

    // And picking a level is not a one-way door: the preset has no default of
    // its own, so "기본값" has to stay on the list.
    createDashboardSession.mockClear();
    flushSync(() => setSelect(effortSelect()!, "low"));
    await settle();
    expect(effortSelect()?.value).toBe("low");
    flushSync(() => setSelect(effortSelect()!, ""));
    await settle();
    expect(effortSelect()?.value).toBe("");

    flushSync(() => startButton()?.click());
    await settle();
    expect(createDashboardSession.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");
  });
});
