/** @vitest-environment jsdom */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgentContextAssemblyView } from "./AgentContextAssemblyView";
import { resetAtomPublicUrlForTests } from "../../../packages/soul-ui/src/hooks/useAtomPublicUrl";
import { assemblyBundles, assemblyContexts, assemblyPreview } from "../v3/agent-profile-assembly-fixture";

it("keeps the newer assembly when an aborted response finishes reading later", async () => {
  const context = assemblyContexts[0]!;
  const older = assemblyPreview({ atom_contexts: [context] });
  older.sections[0]!.title = "이전 결과";
  const newer = assemblyPreview({ atom_contexts: [context] });
  newer.sections[0]!.title = "새 결과";
  let finishOld!: (value: typeof older) => void;
  const oldBody = new Promise<typeof older>(resolve => { finishOld = resolve; });
  const readOld = vi.fn(() => oldBody);
  const oldResponse = Response.json(older);
  vi.spyOn(oldResponse, "json").mockImplementation(readOld);
  const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    request.mock.calls.length === 1 ? oldResponse : Response.json(newer));
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(AgentContextAssemblyView, {
      target: { kind: "central", agentId: "agent", specs: [{ context, source: "프로필" }] },
      nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request,
    })));
    await vi.waitFor(() => expect(readOld).toHaveBeenCalledOnce());
    flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-label="다시 조립"]')!.click());
    await vi.waitFor(() => expect(host.textContent).toContain("새 결과"));
    expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    finishOld(older);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(host.textContent).toContain("새 결과");
    expect(host.textContent).not.toContain("이전 결과");
  } finally {
    flushSync(() => root.unmount()); host.remove();
  }
});

it("keeps the source detail and condition focus while reassembling", async () => {
  let resolveReload!: (response: Response) => void;
  let count = 0;
  const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    if (++count === 1) return Response.json(assemblyPreview(payload));
    return await new Promise<Response>(resolve => { resolveReload = resolve; });
  });
  const context = assemblyContexts[0]!;
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(AgentContextAssemblyView, {
      target: { kind: "central", agentId: "agent", specs: [{ context, source: "프로필" }] },
      nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request,
    })));
    await vi.waitFor(() => expect(host.textContent).toContain("프로필 지침"));
    const row = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("프로필 지침"))!;
    flushSync(() => row.click());
    const backend = host.querySelector<HTMLSelectElement>('select[aria-label="조립 백엔드"]')!;
    backend.focus();
    flushSync(() => { backend.value = "codex"; backend.dispatchEvent(new Event("change", { bubbles: true })); });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="agent-context-assembly-detail"] [data-slot="frame-loading"]')).not.toBeNull());
    expect(host.querySelector('[data-testid="agent-context-assembly-detail"]')).not.toBeNull();
    expect(document.activeElement).toBe(backend);
    resolveReload(Response.json(assemblyPreview({ atom_contexts: [context], session: { backend: "codex" } })));
    await vi.waitFor(() => expect(host.querySelector('[data-slot="context-content-fill"]')).not.toBeNull());
  } finally {
    flushSync(() => root.unmount()); host.remove();
  }
});

it("retries a failed assembly and refreshes only on demand", async () => {
  let calls = 0;
  const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (++calls === 1) return Response.json({ detail: "연결 실패" }, { status: 503 });
    return Response.json(assemblyPreview(JSON.parse(String(init?.body))));
  });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const context = assemblyContexts[0]!;
  const render = (nodeId: string) => flushSync(() => root.render(createElement(AgentContextAssemblyView, {
    target: { kind: "central", agentId: "agent", specs: [{ context: { ...context, node_id: nodeId }, source: "프로필" }] },
    nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request,
  })));
  try {
    render(context.node_id);
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("연결 실패"));
    expect(request).toHaveBeenCalledTimes(1);
    const retry = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "다시 시도")!;
    flushSync(() => retry.click());
    await vi.waitFor(() => expect(container.textContent).toContain("프로필 지침"));
    expect(request).toHaveBeenCalledTimes(2);
    const refresh = () => flushSync(() => container.querySelector<HTMLButtonElement>('button[aria-label="다시 조립"]')!.click());
    refresh();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    render("30000000-0000-4000-8000-000000000001");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledTimes(3);
    refresh();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    expect(JSON.parse(String(request.mock.calls[3]![1]?.body)).atom_contexts[0].node_id).toBe("30000000-0000-4000-8000-000000000001");
  } finally {
    flushSync(() => root.unmount()); container.remove();
  }
});

it("assembles a node-only profile with its agent context and labels the origin", async () => {
  const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
    manifest: { sources: [{ node_id: "source-id", status: "ok", chars: 4, token_estimate: 1 }] },
    sections: [{ spec_index: 0, title: "지침", markdown: "본문" }], assembled: "본문", atom_base_url: null,
  }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(createElement(AgentContextAssemblyView, {
    target: { kind: "node", agentId: "node-agent" }, nodeId: "node-a", initialBackend: "codex", presentOnNode: true, request,
  })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({
    agent_id: "node-agent", session: { source: "browser", backend: "codex", agent: "node-agent" },
  });
  expect(container.textContent).toContain("노드 설정");
  flushSync(() => root.unmount());
  container.remove();
});

it("reassembles for conditions, shows source failures and copies the exact result", async () => {
  const specs = [...assemblyBundles.flatMap(bundle => bundle.atom_contexts), ...assemblyContexts];
  const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(assemblyPreview(JSON.parse(String(init?.body)))));
  const writeText = vi.fn(async (_value: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(createElement(AgentContextAssemblyView, {
    target: { kind: "central", agentId: "agent", specs: specs.map(context => ({ context, source: "번들" })) },
    nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request,
  })));
  await vi.waitFor(() => expect(container.textContent).toContain("실패"));
  expect(container.textContent).toContain("빠짐");
  const change = (label: string, value: string) => {
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
    flushSync(() => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
  };
  change("조립 백엔드", "codex");
  change("조립 카드 역할", "assignee");
  await vi.waitFor(() => expect(JSON.parse(String(request.mock.calls.at(-1)?.[1]?.body)).session).toMatchObject({ backend: "codex", card_role: "assignee" }));
  await vi.waitFor(() => expect(container.textContent).toContain("조건부 지침"));
  const all = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.startsWith("전체"))!;
  flushSync(() => all.click());
  flushSync(() => container.querySelector<HTMLButtonElement>('button[aria-label="전체 복사"]')!.click());
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(assemblyPreview({ atom_contexts: specs, session: { backend: "codex", card_role: "assignee" } }).assembled));
  flushSync(() => root.unmount()); container.remove(); vi.unstubAllGlobals();
});

it("omits token estimates in non-included source details", async () => {
  const base = assemblyBundles.flatMap(bundle => bundle.atom_contexts);
  const specs = [...base, { node_id: "30000000-0000-4000-8000-000000000001", depth: 1 }, base[0]!];
  const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(assemblyPreview(JSON.parse(String(init?.body)))));
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(createElement(AgentContextAssemblyView, {
    target: { kind: "central", agentId: "agent", specs: specs.map(context => ({ context, source: "번들" })) },
    nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request,
  })));
  await vi.waitFor(() => expect(container.textContent).toContain("실패 소스"));
  for (const status of ["filtered", "error", "empty", "duplicate"]) {
    const row = container.querySelector<HTMLButtonElement>(`button[data-status="${status}"]`)!;
    expect(row).not.toBeNull();
    expect(row.textContent).not.toContain("토큰");
    flushSync(() => row.click());
    expect(container.querySelector('[data-testid="agent-context-assembly-detail"]')?.textContent).not.toContain("토큰");
    flushSync(() => container.querySelector<HTMLButtonElement>('button[aria-label="소스 목록으로"]')!.click());
  }
  flushSync(() => root.unmount()); container.remove();
});

afterEach(() => { vi.unstubAllGlobals(); resetAtomPublicUrlForTests(); });

async function renderAtomLinkCase(options: { publicUrl: string | null; baseUrl: string | null }) {
  resetAtomPublicUrlForTests();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ atom_public_url: options.publicUrl })));
  const open = vi.fn();
  vi.stubGlobal("open", open);
  const context = assemblyContexts[0]!;
  const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    Response.json({ ...assemblyPreview(JSON.parse(String(init?.body))), atom_base_url: options.baseUrl }));
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(AgentContextAssemblyView, {
    target: { kind: "central", agentId: "agent", specs: [{ context, source: "프로필" }] },
    nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request,
  })));
  await vi.waitFor(() => expect(host.textContent).toContain("프로필 지침"));
  await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/status"));
  await new Promise(resolve => setTimeout(resolve, 0));
  const atomButtons = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).filter(button => button.getAttribute("aria-label")?.endsWith("atom에서 열기"));
  return { host, root, open, atomButtons };
}

it("opens atom at the public address when the dashboard knows one", async () => {
  const { host, root, open, atomButtons } = await renderAtomLinkCase({ publicUrl: "https://atom.public.example/", baseUrl: "http://127.0.0.1:4200" });
  try {
    await vi.waitFor(() => expect(atomButtons()).toHaveLength(1));
    flushSync(() => atomButtons()[0]!.click());
    expect(open).toHaveBeenCalledWith(`https://atom.public.example/#${assemblyContexts[0]!.node_id}`, "_blank", "noopener");
  } finally { flushSync(() => root.unmount()); host.remove(); }
});

it("falls back to the worker atom_base_url when there is no public address", async () => {
  const { host, root, open, atomButtons } = await renderAtomLinkCase({ publicUrl: null, baseUrl: "https://atom.worker.example" });
  try {
    await vi.waitFor(() => expect(atomButtons()).toHaveLength(1));
    flushSync(() => atomButtons()[0]!.click());
    expect(open).toHaveBeenCalledWith(`https://atom.worker.example/#${assemblyContexts[0]!.node_id}`, "_blank", "noopener");
  } finally { flushSync(() => root.unmount()); host.remove(); }
});

it("draws no atom button when neither address exists", async () => {
  const { host, root, atomButtons } = await renderAtomLinkCase({ publicUrl: null, baseUrl: null });
  try {
    expect(atomButtons()).toHaveLength(0);
  } finally { flushSync(() => root.unmount()); host.remove(); }
});
