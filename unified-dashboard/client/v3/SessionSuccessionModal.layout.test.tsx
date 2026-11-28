/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useOrchestratorStore } from "../store/orchestrator-store";

const createDashboardSession = vi.fn();
vi.mock("../lib/session-create", () => ({
  createDashboardSession: (input: unknown) => createDashboardSession(input),
}));
vi.mock("./folder-workspace-page-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createFolderPageAnchor: vi.fn().mockResolvedValue({ pageId: "page-1", blockId: "anchor", expectedVersion: 1 }),
}));
vi.mock("@seosoyoung/soul-ui/page", () => ({ createPageApiClient: () => ({}) }));

const { SessionSuccessionModal } = await import("./SessionSuccessionModal");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("model-presets")) return Promise.resolve(Response.json({ model_presets: [{ id: "claude-opus", label: "Opus", backend: "claude", available: true }] }));
    if (url.includes("/agents")) return Promise.resolve(Response.json({ agents: [{ id: "roselin", name: "로젤린", default_preset: "claude-opus" }] }));
    return Promise.resolve(Response.json({ children: [{ id: "atom-a", card: { title: "UI 디자인 기준" } }] }));
  }));
  useOrchestratorStore.setState({
    nodes: new Map([["node-a", { nodeId: "node-a", host: "127.0.0.1", port: 1, status: "connected", capabilities: {}, connectedAt: 1, sessionCount: 0 }]]),
    connectionStatus: "connected",
  });
  createDashboardSession.mockReset();
  createDashboardSession.mockResolvedValue({ agentSessionId: "s-new" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  useOrchestratorStore.setState({ nodes: new Map(), connectionStatus: "connecting" });
});

function mount(overrides: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => root.render(createElement(QueryClientProvider, { client }, createElement(SessionSuccessionModal, {
    folderTitle: "소울스트림",
    folderPageId: "page-1",
    folderId: "folder-1",
    contextItems: [{ id: "g", kind: "guidance", icon: "✦", label: "지침" }, { id: "a", kind: "atom", icon: "⚛", label: "자료" }],
    documentOptions: [],
    contextPending: false,
    predecessorOptions: [],
    pageDefaults: { agentId: "roselin", nodeId: "node-a", modelPreset: "claude-opus" } as never,
    currentSession: null,
    atomRequest: globalThis.fetch,
    onClose: () => {},
    onCreated: () => {},
    ...overrides,
  }))));
}

const summaries = () => [...document.body.querySelectorAll("summary")];
const footerButton = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>(".v3-succession-footer button")].find((button) => button.textContent?.trim() === label)!;

describe("new session layout", () => {
  it("orders folder, request, environment and materials, with display names in the environment line", async () => {
    mount();
    const form = document.body.querySelector("fieldset.v3-succession-context-editor")!;
    const order = [...form.children].map((element) => element.querySelector("span, strong")?.textContent?.trim());
    expect(order).toEqual(["시작할 폴더", "무엇을 시작할까요?", "실행 환경", "함께 전달할 자료"]);
    await vi.waitFor(() => expect(summaries()[0]!.textContent).toContain("로젤린 · node-a · Opus"));
    expect(summaries()[0]!.textContent).not.toContain("claude-opus");
    expect(document.body.querySelectorAll(".v3-succession-assignment .v3-succession-assignment")).toHaveLength(0);
    const labels = [...document.body.querySelectorAll(".v3-succession-environment > .v3-succession-assignment:first-child label")].map((label) => label.firstChild?.textContent?.trim());
    expect(labels).toEqual(["노드", "에이전트", "모델"]);
    expect(summaries()[1]!.textContent).toContain("폴더 맥락");
    expect(document.body.textContent).toContain("지침 · 참고 자료 1 · 기본 실행 환경");
  });

  it("lists board documents only when the folder has some", () => {
    mount();
    expect(document.body.textContent).not.toContain("보드 문서");
    flushSync(() => root.unmount());
    root = createRoot(container);
    mount({ documentOptions: [{ pageId: "doc-1", title: "검수 문서" }] });
    expect(document.body.textContent).toContain("보드 문서");
    expect(document.body.querySelector('[role="switch"][aria-label="검수 문서"]')).toBeTruthy();
  });

  it("sends every added reference and drops a removed one", async () => {
    mount();
    const add = [...document.body.querySelectorAll<HTMLButtonElement>(".v3-session-materials button")].find((button) => button.textContent?.trim() === "추가")!;
    for (const depth of ["2", "4"]) {
      flushSync(() => add.click());
      await vi.waitFor(() => expect([...document.body.querySelectorAll("button")].some((button) => button.textContent?.trim() === "UI 디자인 기준")).toBe(true));
      flushSync(() => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "UI 디자인 기준")!.click());
      flushSync(() => [...document.body.querySelectorAll<HTMLButtonElement>(".v3-reference-picker button")].find((button) => button.textContent?.trim() === depth)!.click());
      flushSync(() => footerButton("추가").click());
    }
    expect(document.body.querySelectorAll('.v3-reference-rows button[aria-label="UI 디자인 기준 고치기"]')).toHaveLength(1);
    expect(document.body.querySelector(".v3-reference-rows")!.textContent).toContain("깊이 4");
    await vi.waitFor(() => expect(footerButton("세션 시작").disabled).toBe(false));
    flushSync(() => footerButton("세션 시작").click());
    await vi.waitFor(() => expect(createDashboardSession).toHaveBeenCalled());
    const items = createDashboardSession.mock.calls[0]![0].contextItems as Array<{ key: string; content: { nodes?: unknown[] } }>;
    expect(items.find((item) => item.key === "atom_context_sources")?.content.nodes).toEqual([{ node_id: "atom-a", depth: 4, titles_only: false }]);
  });

  it("removes a reference with its remove button", async () => {
    mount();
    const add = [...document.body.querySelectorAll<HTMLButtonElement>(".v3-session-materials button")].find((button) => button.textContent?.trim() === "추가")!;
    flushSync(() => add.click());
    await vi.waitFor(() => expect([...document.body.querySelectorAll("button")].some((button) => button.textContent?.trim() === "UI 디자인 기준")).toBe(true));
    flushSync(() => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "UI 디자인 기준")!.click());
    flushSync(() => footerButton("추가").click());
    flushSync(() => document.body.querySelector<HTMLButtonElement>('button[aria-label="UI 디자인 기준 빼기"]')!.click());
    expect(document.body.querySelector(".v3-reference-rows")).toBeNull();
  });
});
