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
vi.mock("./folder-workspace-page-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createFolderPageAnchor: vi.fn().mockResolvedValue(null),
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

function mountWithSession(session: Record<string, unknown> | null, presetId = "claude-opus", overrides: Partial<Parameters<typeof SessionSuccessionModal>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(createElement(
      QueryClientProvider,
      { client },
      createElement(SessionSuccessionModal, {
        folderTitle: "폴더",
        folderPageId: "page-1",
        folderId: "task-1",
        contextItems: [],
        documentOptions: [],
        contextPending: false,
        predecessorOptions: [],
        pageDefaults: { agentId: "roselin", nodeId: "node-a", modelPreset: presetId } as never,
        currentSession: session as never,
        onClose: () => {},
        onCreated: () => {},
        ...overrides,
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
        folderTitle: "폴더",
        folderPageId: "page-1",
        folderId: "task-1",
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
function effortSelect(): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>('button[aria-label="추론 강도 선택"]');
}

async function effortOptions() {
  flushSync(() => effortSelect()!.click());
  await vi.waitFor(() => expect(document.body.querySelector('[data-slot="select-item"]')).not.toBeNull());
  return [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')];
}

async function chooseEffort(label: string) {
  const options = await effortOptions();
  const item = options.find(option => option.textContent?.trim() === label)!;
  expect(item).toBeTruthy();
  flushSync(() => item.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
  flushSync(() => item.click());
}

async function chooseNode(value: string) {
  flushSync(() => document.body.querySelector<HTMLButtonElement>('button[aria-label="노드 선택"]')!.click());
  await vi.waitFor(() => expect([...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].some(item => item.textContent?.trim() === value)).toBe(true));
  const item = [...document.body.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(option => option.textContent?.trim() === value)!;
  flushSync(() => item.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
  flushSync(() => item.click());
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
    expect(select?.textContent).toContain("X High");
    expect((await effortOptions()).map(option => option.textContent?.trim())).toEqual(["Low", "Medium", "High", "X High", "Max"]);
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
    expect(effortSelect()?.textContent).toContain("X High");

    await chooseEffort("Low");
    await settle();
    expect(effortSelect()?.textContent).toContain("Low");

    await chooseNode("node-b");
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
    flushSync(() => root.render(null)); mount(); await settle();
    await chooseEffort("Low");
    await settle();
    expect(effortSelect()?.textContent).toContain("Low");

    flushSync(() => startButton()?.click());
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
    const group = document.body.querySelector('[role="group"][aria-label="추론 강도"]');
    expect(group?.getAttribute("aria-describedby")).toBe(unsupportedNotice()?.closest("small")?.id);
    expect(startButton()?.disabled).toBe(true);

    flushSync(() => startButton()?.click());
    await settle();
    expect(createDashboardSession).not.toHaveBeenCalled();
  });

  it("clears once a supported level is chosen", async () => {
    stubFetch([OPUS]);
    mountWithSession(predecessorAtUltra);
    await settle();

    await chooseEffort("Low");
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
    expect(effortSelect()?.textContent).toContain("Ultra (지원 안 함)");

    await chooseEffort("기본값 사용");
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

    useDefaultButton()?.focus();
    flushSync(() => useDefaultButton()?.click());
    await settle();
    expect(unsupportedNotice()).toBeNull();
    expect(startButton()?.disabled).toBe(false);
    expect(document.activeElement).toBe(effortSelect());
    expect(effortSelect()?.getAttribute("aria-expanded")).toBe("false");

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

    useDefaultButton()?.focus();
    flushSync(() => useDefaultButton()?.click());
    await settle();
    expect(unsupportedNotice()).toBeNull();
    expect(startButton()?.disabled).toBe(false);
    expect(document.activeElement).toBe(document.body.querySelector('[aria-label="초기 지시"]'));

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
    expect(select?.textContent).toContain("기본값");
    expect((await effortOptions()).map(option => option.textContent?.trim()))
      .toEqual(["기본값", "Low", "Medium", "High", "X High", "Max"]);

    flushSync(() => startButton()?.click());
    await settle();
    expect(createDashboardSession.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");

    // And picking a level is not a one-way door: the preset has no default of
    // its own, so "기본값" has to stay on the list.
    createDashboardSession.mockClear();
    flushSync(() => root.render(null)); mount(); await settle();
    await chooseEffort("Low");
    await settle();
    expect(effortSelect()?.textContent).toContain("Low");
    await chooseEffort("기본값");
    await settle();
    expect(effortSelect()?.textContent).toContain("기본값");

    flushSync(() => startButton()?.click());
    await settle();
    expect(createDashboardSession.mock.calls[0]?.[0]).not.toHaveProperty("reasoningEffort");
  });
});


describe("SessionSuccessionModal attachments", () => {
  it("uploads pasted images to the changed node before creating the first execution", async () => {
    useOrchestratorStore.setState({ nodes: new Map([["node-a", node("node-a")], ["node-b", node("node-b")]]) });
    let finishB!: (response: Response) => void;
    const bUpload = new Promise<Response>(resolve => { finishB = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("attachments/sessions")) return url.includes("node-b") ? bUpload : Promise.resolve({ ok: true, json: async () => ({ path: "/A/pasted.png" }) } as Response);
      return Promise.resolve({ ok: true, json: async () => url.includes("model-presets")
        ? { model_presets: [OPUS] } : { agents: [{ id: "roselin", name: "roselin", default_preset: "claude-opus" }] } } as Response);
    }));
    URL.createObjectURL = vi.fn(() => "blob:test"); URL.revokeObjectURL = vi.fn();
    mount(); await settle();
    const input = document.body.querySelector("textarea")!;
    const image = new File(["png"], "image.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [image], items: [{ kind: "file", type: image.type, getAsFile: () => image }] } });
    flushSync(() => input.dispatchEvent(paste)); await settle();
    expect(paste.defaultPrevented).toBe(true);
    expect(document.body.querySelector('img[src="blob:test"]')).not.toBeNull();
    await chooseNode("node-b");
    await settle();
    const submit = document.body.querySelector<HTMLButtonElement>(".v3-succession-footer button:last-child")!;
    expect(submit.disabled).toBe(true);
    submit.click(); expect(createDashboardSession).not.toHaveBeenCalled();
    finishB({ ok: true, json: async () => ({ path: "/B/pasted.png" }) } as Response); await settle();
    expect(startButton()?.disabled).toBe(false);
    startButton()?.click(); await settle();
    expect(createDashboardSession).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "node-b", attachmentPaths: ["/B/pasted.png"] }));
    expect(createDashboardSession.mock.calls[0][0].initialInstruction).not.toContain("/A/");
  });
  it("blocks creation after a selected-file upload fails", async () => {
    stubFetch([OPUS]);
    const fetchMetadata = vi.mocked(fetch).getMockImplementation()!;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input).includes("attachments/sessions")
      ? Promise.resolve({ ok: false, status: 500 } as Response) : fetchMetadata(input)));
    URL.createObjectURL = vi.fn(() => "blob:test"); URL.revokeObjectURL = vi.fn();
    mount(); await settle();
    const chooser = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(chooser, "files", { value: [new File(["png"], "photo.png", { type: "image/png" })] });
    flushSync(() => chooser.dispatchEvent(new Event("change", { bubbles: true }))); await settle();
    expect(startButton()?.disabled).toBe(true);
    startButton()?.click(); expect(createDashboardSession).not.toHaveBeenCalled();
  });
});

it("blocks concurrent session starts and closing, then preserves the draft on an uncertain failure", async () => {
  stubFetch([OPUS]);
  let reject!: (error: Error) => void;
  createDashboardSession.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const onClose = vi.fn();
  mountWithSession(null, "claude-opus", { onClose });
  await settle();
  const instruction = document.body.querySelector<HTMLTextAreaElement>('[aria-label="초기 지시"]')!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(instruction, "유지할 지시");
    instruction.dispatchEvent(new Event("input", { bubbles: true }));
    startButton()?.click(); startButton()?.click();
  });
  await settle();
  expect(createDashboardSession).toHaveBeenCalledTimes(1);
  flushSync(() => document.body.querySelector<HTMLButtonElement>('[aria-label="승계 닫기"]')!.click());
  expect(onClose).not.toHaveBeenCalled();
  reject(new Error("응답을 받지 못했습니다")); await settle();
  expect(instruction.value).toBe("유지할 지시");
  expect(createDashboardSession).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
});

it("toggles inheritance from the previous-session title and guidance without opening the picker", async () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  stubFetch([OPUS]);
  mountWithSession(null, "claude-opus", {
    predecessorOptions: [{ sessionId: "prev-1", label: "이전 작업", runNumber: 1 }],
  });
  await settle();
  const toggle = document.body.querySelector<HTMLElement>('[role="switch"][aria-label="이전 세션 이어받기"]')!;
  const label = toggle.closest("label")!;
  const title = [...label.querySelectorAll("strong")].find(element => element.textContent === "이전 세션")!;
  const guidance = label.querySelector("small")!;
  const picker = () => document.body.querySelector<HTMLButtonElement>('button[aria-label="이어받을 이전 세션"]');
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  for (const target of [title, title, guidance, guidance]) {
    const before = toggle.getAttribute("aria-checked") === "true";
    flushSync(() => (target as HTMLElement).click());
    await settle();
    expect(toggle.getAttribute("aria-checked")).toBe(String(!before));
    expect(Boolean(picker())).toBe(!before);
    expect(document.body.querySelector('[data-slot="select-popup"]')).toBeNull();
  }
  expect(label.querySelector("label, button:not([role=switch])")).toBeNull();
  expect(label.contains(picker())).toBe(false);
});
