/** @vitest-environment jsdom */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentContextAssemblyView } from "./AgentContextAssemblyView";
import { resetAtomPublicUrlForTests } from "../../../packages/soul-ui/src/hooks/useAtomPublicUrl";
import { assemblyBundles, assemblyContexts, assemblyPreview } from "../v3/agent-profile-assembly-fixture";
import { assemblyPreviewDocuments } from "../v3/guides-api";
import { guideReport, guideSkills } from "../v3/guides-fixture";

/** 스킬 목록(/api/skill-guides)은 따로 답하고 나머지는 시험이 센 요청으로 보낸다. guides를 안 주면 목록은 실패한다. */
function routed(request: typeof fetch | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>), guides?: unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => String(input).startsWith("/api/skill-guides")
    ? guides === undefined ? new Response("{}", { status: 503 }) : Response.json(guides)
    : request(input, init)) as typeof fetch;
}

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
      nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request: routed(request),
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
      nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request: routed(request),
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
  const guided = routed(request);
  const render = (nodeId: string) => flushSync(() => root.render(createElement(AgentContextAssemblyView, {
    target: { kind: "central", agentId: "agent", specs: [{ context: { ...context, node_id: nodeId }, source: "프로필" }] },
    nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request: guided,
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
    target: { kind: "node", agentId: "node-agent" }, nodeId: "node-a", initialBackend: "codex", presentOnNode: true, request: routed(request),
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
    nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request: routed(request),
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
    nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request: routed(request),
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
    nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request: routed(request),
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

describe("documents가 있는 새 응답과 없는 옛 응답", () => {
  const specs = [...assemblyBundles.flatMap(bundle => bundle.atom_contexts), ...assemblyContexts].slice(0, 2);
  async function mountView(preview: (body: Parameters<typeof assemblyPreview>[0]) => unknown) {
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(preview(JSON.parse(String(init?.body)))));
    const guides = { skills: guideSkills, catalogs: [], report: guideReport };
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(createElement(AgentContextAssemblyView, {
      target: { kind: "central", agentId: "agent", specs: specs.map(context => ({ context, source: "공통 규칙" })) },
      nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request: routed(request, guides),
    })));
    await vi.waitFor(() => expect(host.textContent).toContain("스킬 목록"));
    return { host, unmount: () => { flushSync(() => root.unmount()); host.remove(); } };
  }
  const sourceRows = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLButtonElement>("button[data-status]"));

  it("소스 줄을 누르면 실린 문서 트리(글자 수, 실린 방식)가 펴지고 본문은 「본문 보기」로 연다", async () => {
    const { host, unmount } = await mountView(assemblyPreviewDocuments);
    const [first] = sourceRows(host);
    expect(first!.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[data-testid="agent-context-documents"]')).toBeNull();
    // 같은 이름의 소스를 부모 문서 제목으로 가른다.
    expect(first!.textContent).toContain("공통 / ");
    flushSync(() => first!.click());
    const tree = host.querySelector('[data-testid="agent-context-documents"]')!;
    expect(first!.getAttribute("aria-expanded")).toBe("true");
    expect(tree.querySelectorAll("li").length).toBe(5);
    expect(tree.textContent).toContain("본문까지");
    expect(tree.textContent).toMatch(/\d{1,3}(,\d{3})*자/);
    expect(tree.textContent).not.toContain("토큰");
    expect(host.querySelector('[data-testid="agent-context-assembly-detail"]')).toBeNull();
    flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-label$="본문 보기"]')!.click());
    expect(host.querySelector('[data-testid="agent-context-assembly-detail"]')).not.toBeNull();
    unmount();
  });

  it("줄 오른쪽의 수는 글자 수 하나로 적고 토큰은 「전체」 줄에만 남는다", async () => {
    const { host, unmount } = await mountView(assemblyPreviewDocuments);
    for (const row of sourceRows(host).filter(item => item.dataset.status === "ok")) {
      expect(row.textContent).toMatch(/자$/);
      expect(row.textContent).not.toContain("토큰");
    }
    const all = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.startsWith("전체"))!;
    expect(all.textContent).toContain("토큰");
    unmount();
  });

  it("스킬 구역은 스킬마다 설명, 진단 배지, 나가는 연결을 보이고 실린 방식이 모두 같으면 머리에 한 번만 적는다", async () => {
    const { host, unmount } = await mountView(assemblyPreviewDocuments);
    const section = host.querySelector('[data-testid="agent-context-skills"]')!;
    const buttons = Array.from(section.querySelectorAll("button"));
    expect(buttons.length).toBe(8);
    expect(section.querySelector("h4")!.parentElement!.textContent).toContain("본문까지");
    expect(buttons.some(button => button.textContent?.includes("본문까지"))).toBe(false);
    const first = buttons[0]!;
    expect(first.textContent).toContain(guideSkills[1]!.name);
    expect(first.textContent).toContain(guideSkills[1]!.description.slice(0, 12));
    expect(section.textContent).toContain("11월 25일 14:30 검증");
    expect(Array.from(section.querySelectorAll("[data-slot='badge']")).length).toBeGreaterThan(0);
    flushSync(() => first.click());
    expect(host.querySelector('[data-testid="agent-context-skill-original"]')).not.toBeNull();
    unmount();
  });

  it("documents가 없는 옛 응답은 펼침 없이 줄을 누르면 본문이 열리고 스킬 구역도 없다", async () => {
    const { host, unmount } = await mountView(assemblyPreview);
    const [first] = sourceRows(host);
    expect(first!.hasAttribute("aria-expanded")).toBe(false);
    expect(host.querySelector('button[aria-label$="본문 보기"]')).toBeNull();
    expect(host.querySelector('[data-testid="agent-context-skills"]')).toBeNull();
    flushSync(() => first!.click());
    expect(host.querySelector('[data-testid="agent-context-assembly-detail"]')).not.toBeNull();
    unmount();
  });

  it("실서버 꼴: 제목, 부모 제목, 실린 문서는 manifest.sources에만 있고 sections에는 칸이 없다", async () => {
    const entry = guideSkills.find(item => item.entry_card_id && item.entry_node_id)!;
    const serverShape = () => ({
      manifest: {
        sources: [
          { node_id: "11111111-aaaa", mode: "full", depth: 3, status: "ok", chars: 900, token_estimate: 225, title: "규칙", parent_title: "공통",
            documents: [{ node_id: "11111111-aaaa", card_id: "card-root", title: "규칙", depth: 0, chars: 300 }, { node_id: "11111111-bbbb", card_id: null, title: "카드 없는 절", depth: 1, chars: 600 }] },
          { node_id: "22222222-aaaa", mode: "full", depth: 3, status: "ok", chars: 400, token_estimate: 100, title: "스킬 목록", parent_title: "공통",
            documents: [{ node_id: "22222222-aaaa", card_id: "card-skills", title: "스킬 목록", depth: 0, chars: 0 }, { node_id: entry.entry_node_id, card_id: entry.entry_card_id, title: entry.name, depth: 1, chars: 280 }] },
        ],
        total_chars: 1300, total_token_estimate: 325,
      },
      assembled: "# 규칙\n\n본문",
      sections: [{ spec_index: 0, title: "규칙", markdown: "# 규칙" }, { spec_index: 1, title: "스킬 목록", markdown: "# 스킬 목록" }],
      atom_base_url: null,
    });
    const request = vi.fn(async () => Response.json(serverShape()));
    const guides = { skills: guideSkills, catalogs: [], report: guideReport };
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(createElement(AgentContextAssemblyView, {
      target: { kind: "central", agentId: "agent", specs: specs.map(context => ({ context, source: "공통 규칙" })) },
      nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request: routed(request, guides),
    })));
    await vi.waitFor(() => expect(sourceRows(host).length).toBe(2));
    const [first] = sourceRows(host);
    // 「공통 / 규칙」 가르기와 펼침이 manifest.sources에서 온다.
    expect(first!.textContent).toContain("공통 / ");
    expect(first!.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => first!.click());
    const tree = host.querySelector('[data-testid="agent-context-documents"]')!;
    expect(tree.querySelectorAll("li").length).toBe(2);
    expect(tree.textContent).toContain("카드 없는 절");
    expect(host.querySelector('[data-testid="agent-context-skills"]')?.textContent).toContain(entry.name);
    flushSync(() => root.unmount()); host.remove();
  });

  it("스킬 목록(/api/skill-guides)을 못 받아도 구성 화면은 그대로 서고 스킬 구역만 빠진다", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => Response.json(assemblyPreviewDocuments(JSON.parse(String(init?.body)))));
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(createElement(AgentContextAssemblyView, {
      target: { kind: "central", agentId: "agent", specs: specs.map(context => ({ context, source: "공통 규칙" })) },
      nodeId: "node-a", initialBackend: "claude", presentOnNode: true, request: routed(request),
    })));
    await vi.waitFor(() => expect(host.textContent).toContain("스킬 목록"));
    expect(host.querySelector('[data-testid="agent-context-skills"]')).toBeNull();
    expect(sourceRows(host).length).toBeGreaterThan(0);
    flushSync(() => root.unmount()); host.remove();
  });
});
