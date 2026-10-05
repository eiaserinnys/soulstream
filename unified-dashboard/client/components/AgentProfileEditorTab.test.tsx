/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useOrchestratorStore } from "../store/orchestrator-store";
import { AgentProfileEditorTab } from "./AgentProfileEditorTab";

const profile = {
  agent_id: "seosoyoung",
  name: "서소영",
  context_bundles: [],
  atom_contexts: [{
    node_id: "11111111-2222-3333-4444-555555555555",
    mode: "full",
    depth: 2,
    applies_when: {
      source: ["browser", "agent"],
      future_field: ["keep-me"],
    },
  }],
  effective_atom_contexts: [{
    node_id: "11111111-2222-3333-4444-555555555555",
    mode: "full",
    depth: 2,
    applies_when: {
      source: ["browser", "agent"],
      future_field: ["keep-me"],
    },
  }],
  default_preset: "codex-sol",
  aliases: [{ id: "soy", default_preset: "codex-terra" }],
  has_portrait: false,
  portrait: null,
  version: 3,
  created_at: "2026-08-07T00:00:00.000Z",
  updated_at: "2026-08-07T00:00:00.000Z",
};

const bundles = [
  {
    bundle_id: "common-rules",
    description: "공통 규칙",
    atom_contexts: [{ node_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", mode: "index" }],
    version: 1,
    created_at: "2026-09-28T00:00:00.000Z",
    updated_at: "2026-09-28T00:00:00.000Z",
  },
  {
    bundle_id: "coding",
    description: "코딩 지침",
    atom_contexts: [{ node_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", mode: "full", depth: 3 }],
    version: 2,
    created_at: "2026-09-28T00:00:00.000Z",
    updated_at: "2026-09-28T00:00:00.000Z",
  },
  {
    bundle_id: "human-facing",
    description: "대화 지침",
    atom_contexts: [{ node_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", mode: "titles" }],
    version: 1,
    created_at: "2026-09-28T00:00:00.000Z",
    updated_at: "2026-09-28T00:00:00.000Z",
  },
  {
    bundle_id: "windows-host",
    description: "윈도우 노드",
    atom_contexts: [{ node_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", mode: "index", applies_when: { os: ["windows"] } }],
    version: 1,
    created_at: "2026-09-28T00:00:00.000Z",
    updated_at: "2026-09-28T00:00:00.000Z",
  },
];

const bundledProfile = {
  ...profile,
  context_bundles: ["common-rules", "coding", "human-facing"],
  effective_atom_contexts: [...bundles.slice(0, 3).flatMap((bundle) => bundle.atom_contexts), ...profile.atom_contexts],
};

const portraitProfile = {
  ...profile,
  has_portrait: true,
  portrait: { mime: "image/png", size: 12, sha256: "old-sha" },
};

describe("AgentProfileEditorTab", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    useOrchestratorStore.setState({
      nodes: new Map([[
        "node-a",
        {
          nodeId: "node-a",
          host: "127.0.0.1",
          port: 4105,
          status: "connected",
          capabilities: {},
          connectedAt: 1,
          sessionCount: 0,
        },
      ]]),
      connectionStatus: "connected",
    });
  });

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    container?.remove();
    document.body.innerHTML = "";
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the saved portrait in the list and form, and a placeholder for profiles without one", async () => {
    const withoutPortrait = { ...profile, agent_id: "roselin", name: "로젤린" };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      String(input) === "/api/context-bundles"
        ? jsonResponse({ bundles: [] })
        : jsonResponse({ profiles: [portraitProfile, withoutPortrait] })));
    await renderEditor();

    const expectedUrl = "/api/agent-profiles/seosoyoung/portrait?v=old-sha";
    expect(profileButton("서소영").querySelector("img")?.getAttribute("src")).toBe(expectedUrl);
    expect(profileButton("서소영").querySelector("img")?.getAttribute("alt")).toBe("서소영");
    expect(document.body.querySelector('[data-testid="agent-profile-editor"] img')?.getAttribute("src"))
      .toBe(expectedUrl);
    expect(profileButton("로젤린").querySelector("img")).toBeNull();
    expect(profileButton("로젤린").textContent).toContain("로");

    const removeCheckbox = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    flushSync(() => removeCheckbox?.click());
    expect(document.body.querySelector('[data-testid="agent-profile-editor"] img')).toBeNull();
    expect(document.body.querySelector('[data-testid="profile-portrait-placeholder"]')).not.toBeNull();

    flushSync(() => profileButton("로젤린").click());
    expect(document.body.querySelector('[data-testid="agent-profile-editor"] img')).toBeNull();
    expect(document.body.querySelector('[data-testid="profile-portrait-placeholder"]')).not.toBeNull();
  });

  it("previews a selected portrait immediately and uses the returned sha after saving", async () => {
    const NativeURL = URL;
    const createObjectURL = vi.fn(() => "blob:selected-portrait");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends NativeURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/context-bundles") return jsonResponse({ bundles: [] });
      if (init?.method === "PUT" && url.endsWith("/portrait")) {
        return jsonResponse({ ...portraitProfile, version: 5, portrait: { ...portraitProfile.portrait, sha256: "new-sha" } });
      }
      if (init?.method === "PUT") return jsonResponse({ ...portraitProfile, version: 4 });
      return jsonResponse({ profiles: [portraitProfile] });
    }));
    await renderEditor();

    const fileInput = document.body.querySelector<HTMLInputElement>('input[aria-label="초상화"]');
    expect(fileInput).not.toBeNull();
    const file = new File(["new image"], "new.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    flushSync(() => fileInput?.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();
    expect(createObjectURL).toHaveBeenCalledWith(file);
    expect(document.body.querySelector('[data-testid="agent-profile-editor"] img')?.getAttribute("src"))
      .toBe("blob:selected-portrait");

    clickButton("프로필 저장");
    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="status"]')?.textContent).toContain("프로필을 저장했습니다.");
    });
    expect(requests).toContain("PUT /api/agent-profiles/seosoyoung/portrait");
    expect(document.body.querySelector('[data-testid="agent-profile-editor"] img')?.getAttribute("src"))
      .toBe("/api/agent-profiles/seosoyoung/portrait?v=new-sha");
    expect(profileButton("서소영").querySelector("img")?.getAttribute("src"))
      .toBe("/api/agent-profiles/seosoyoung/portrait?v=new-sha");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:selected-portrait");
  });

  it("explains where context bundles are edited and how they are used", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      String(input) === "/api/context-bundles"
        ? jsonResponse({ bundles })
        : jsonResponse({ profiles: [profile] })));
    await renderEditor();

    expect(document.body.textContent).toContain("번들 자체의 내용을 고치려면 상단 「컨텍스트 번들 편집」으로 가십시오.");
    clickButton("컨텍스트 번들 편집");
    expect(document.body.querySelector("h2")?.textContent).toBe("컨텍스트 번들");
    expect(document.body.textContent).toContain("여러 프로필이 함께 쓰는 atom 컨텍스트 묶음입니다. 여기서 번들을 만들고 고치면, 각 프로필의 「컨텍스트 번들」 절에서 참조합니다. 참조 중인 번들은 삭제할 수 없습니다.");
    clickButton("← 프로필 편집으로");
    expect(document.body.querySelector('[data-testid="agent-profile-editor"]')).not.toBeNull();
  });

  it("saves the edited profile with its optimistic version and preserved conditions", async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      if (method === "PUT") return jsonResponse({ ...profile, name: "새 이름", version: 4 });
      return jsonResponse({ profiles: [profile] });
    }));
    await renderEditor();

    setInput("이름", "새 이름");
    clickButton("프로필 저장");
    await settle();

    const saveRequest = requests.find((request) => request.method === "PUT");
    expect(saveRequest).toMatchObject({
      url: "/api/agent-profiles/seosoyoung",
      body: {
        name: "새 이름",
        expected_version: 3,
        atom_contexts: [{
          node_id: "11111111-2222-3333-4444-555555555555",
          mode: "full",
          depth: 2,
          applies_when: {
            source: ["browser", "agent"],
            future_field: ["keep-me"],
          },
        }],
      },
    });
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe("프로필을 저장했습니다.");
  });

  it("starts a new profile with an empty bundle list", async () => {
    const writes: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/context-bundles") return jsonResponse({ bundles });
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({
          ...profile,
          agent_id: "new-agent",
          name: "새 에이전트",
          atom_contexts: [],
          effective_atom_contexts: [],
          version: 1,
        });
      }
      return jsonResponse({ profiles: [profile] });
    }));
    await renderEditor();
    clickButton("새 프로필");
    setInput("에이전트 ID", "new-agent");
    setInput("이름", "새 에이전트");
    clickButton("프로필 저장");
    await settle();
    expect(writes[0]?.context_bundles).toEqual([]);
  });

  it("preserves three bundle references when only the profile name changes", async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    let persistedBundles = [...bundledProfile.context_bundles];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      if (url === "/api/context-bundles") return jsonResponse({ bundles });
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        persistedBundles = Array.isArray(body.context_bundles) ? body.context_bundles as string[] : [];
        return jsonResponse({
          ...bundledProfile,
          name: body.name,
          context_bundles: persistedBundles,
          effective_atom_contexts: [
            ...persistedBundles.flatMap((id) => bundles.find((bundle) => bundle.bundle_id === id)?.atom_contexts ?? []),
            ...profile.atom_contexts,
          ],
          version: 4,
        });
      }
      if (url === "/api/agent-profiles/seosoyoung") {
        return jsonResponse({ ...bundledProfile, name: "새 이름", context_bundles: persistedBundles, version: 4 });
      }
      return jsonResponse({ profiles: [bundledProfile] });
    }));
    await renderEditor();

    setInput("이름", "새 이름");
    clickButton("프로필 저장");
    await settle();

    expect(requests.find((request) => request.method === "PUT")).toMatchObject({
      url: "/api/agent-profiles/seosoyoung",
      body: {
        name: "새 이름",
        context_bundles: ["common-rules", "coding", "human-facing"],
        expected_version: 3,
      },
    });
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe("프로필을 저장했습니다.");
    const afterSave = await (await fetch("/api/agent-profiles/seosoyoung")).json() as typeof bundledProfile;
    expect(afterSave.context_bundles).toEqual(["common-rules", "coding", "human-facing"]);
  });

  it("updates effective order and preview immediately when references change", async () => {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      if (url === "/api/context-bundles") return jsonResponse({ bundles });
      if (url.includes("context-preview")) return jsonResponse({ manifest: { sources: [] } });
      if (method === "PUT") return jsonResponse({ ...bundledProfile, version: 4 });
      return jsonResponse({ profiles: [bundledProfile] });
    }));
    await renderEditor();

    expect(effectiveRows()).toEqual([
      "common-rules", "coding", "human-facing", "프로필",
    ]);
    clickButtonByLabel("common-rules 아래로");
    clickButtonByLabel("human-facing 제거");
    setSelect("추가할 번들", "windows-host");
    clickButton("번들 추가");
    expect(effectiveRows()).toEqual(["coding", "common-rules", "windows-host", "프로필"]);
    expect(document.body.querySelector('[data-testid="effective-atom-contexts"]')?.textContent)
      .toContain("os: windows");

    clickButton("dry-run 실행");
    await settle();
    expect(requests.find((request) => request.url.includes("context-preview"))?.body?.atom_contexts)
      .toEqual([
        bundles[1].atom_contexts[0],
        bundles[0].atom_contexts[0],
        bundles[3].atom_contexts[0],
        profile.atom_contexts[0],
      ]);
    clickButton("프로필 저장");
    await settle();
    expect(requests.find((request) => request.method === "PUT")?.body?.context_bundles)
      .toEqual(["coding", "common-rules", "windows-host"]);
  });

  it("creates, edits and deletes a bundle with applies_when fields", async () => {
    let stored = [...bundles];
    const writes: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/context-bundles" && method === "GET") return jsonResponse({ bundles: stored });
      if (url.startsWith("/api/context-bundles/") && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writes.push({ url, method, body });
        const bundle_id = decodeURIComponent(url.split("/").pop() ?? "");
        const previous = stored.find((bundle) => bundle.bundle_id === bundle_id);
        const saved = {
          bundle_id,
          description: body.description as string,
          atom_contexts: body.atom_contexts as typeof bundles[0]["atom_contexts"],
          version: (previous?.version ?? 0) + 1,
          created_at: previous?.created_at ?? "2026-09-29T00:00:00.000Z",
          updated_at: "2026-09-29T00:00:00.000Z",
        };
        stored = [...stored.filter((bundle) => bundle.bundle_id !== bundle_id), saved];
        return jsonResponse(saved);
      }
      if (url.startsWith("/api/context-bundles/") && method === "DELETE") {
        writes.push({ url, method, body: JSON.parse(String(init?.body)) });
        stored = stored.filter((bundle) => bundle.bundle_id !== decodeURIComponent(url.split("/").pop() ?? ""));
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ profiles: [profile] });
    }));
    await renderEditor();
    clickButton("컨텍스트 번들 편집");
    clickButton("새 번들");
    setInput("번들 ID", "new-bundle");
    setInput("설명", "새 번들");
    clickButton("소스 추가");
    setInput("Atom node UUID", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    setInput("조건 · OS", "linux, windows");
    setInput("조건 · 백엔드", "codex");
    setInput("조건 · 카드 역할", "assignee");
    clickButton("번들 저장");
    await settle();

    expect(writes[0]).toMatchObject({
      url: "/api/context-bundles/new-bundle",
      method: "PUT",
      body: {
        description: "새 번들",
        expected_version: null,
        atom_contexts: [{
          node_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          applies_when: { os: ["linux", "windows"], backend: ["codex"], card_role: ["assignee"] },
        }],
      },
    });
    expect(document.body.querySelector('button[aria-label="new-bundle"]')).not.toBeNull();
    setInput("설명", "수정한 번들");
    clickButton("번들 저장");
    await settle();
    expect(writes[1]?.body).toMatchObject({ description: "수정한 번들", expected_version: 1 });
    clickButton("번들 삭제");
    await settle();
    expect(writes[2]).toMatchObject({
      url: "/api/context-bundles/new-bundle",
      method: "DELETE",
      body: { expected_version: 2 },
    });
    expect(document.body.querySelector('button[aria-label="new-bundle"]')).toBeNull();
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe("번들을 삭제했습니다.");
  });

  it("shows referencing profiles when bundle deletion is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/context-bundles") return jsonResponse({ bundles });
      if (init?.method === "DELETE") {
        return jsonResponse({
          detail: "Context bundle is referenced by agent profiles",
          referenced_by: ["seosoyoung", "roselin"],
        }, 409);
      }
      return jsonResponse({ profiles: [bundledProfile] });
    }));
    await renderEditor();
    clickButton("컨텍스트 번들 편집");
    clickButtonByLabel("coding");
    clickButton("번들 삭제");
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent)
      .toContain("seosoyoung, roselin");
  });

  it("keeps an edited bundle draft on version conflict", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/context-bundles") return jsonResponse({ bundles });
      if (init?.method === "PUT") {
        return jsonResponse({
          code: "context_bundle_version_conflict",
          detail: "Context bundle changed",
        }, 409);
      }
      return jsonResponse({ profiles: [profile] });
    }));
    await renderEditor();
    clickButton("컨텍스트 번들 편집");
    clickButtonByLabel("coding");
    setInput("설명", "충돌할 초안");
    clickButton("번들 저장");
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent)
      .toContain("다른 사용자가 먼저 수정했습니다.");
    expect(document.body.textContent).toContain("최신 버전 다시 불러오기");
    expect(document.body.querySelector<HTMLInputElement>('input[aria-label="설명"]')?.value)
      .toBe("충돌할 초안");
  });

  it("explains optimistic version conflicts without discarding the draft", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return jsonResponse(
          { code: "agent_profile_version_conflict", detail: "Agent profile changed" },
          409,
        );
      }
      return jsonResponse({ profiles: [profile] });
    }));
    await renderEditor();

    setInput("이름", "충돌할 초안");
    clickButton("프로필 저장");
    await settle();

    expect(document.body.textContent).toContain("다른 사용자가 먼저 수정했습니다.");
    expect(document.body.textContent).toContain("최신 버전 다시 불러오기");
    expect((document.body.querySelector('input[aria-label="이름"]') as HTMLInputElement).value)
      .toBe("충돌할 초안");
  });

  it("dry-runs the editing spec and shows per-source character and token estimates", async () => {
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      });
      if (url.includes("context-preview")) {
        return jsonResponse({
          manifest: {
            sources: [{
              id: "profile:0",
              label: "운영 지침",
              status: "filtered",
              chars: 345,
              token_estimate: 87,
            }],
          },
        });
      }
      return jsonResponse({ profiles: [profile] });
    }));
    await renderEditor();

    const sourceOptions = Array.from(
      document.body.querySelectorAll<HTMLOptionElement>('select[aria-label="미리보기 호출 소스"] option'),
      (option) => option.value,
    );
    expect(sourceOptions).toEqual(expect.arrayContaining(["channel_observer", "trello_watcher"]));

    clickButton("dry-run 실행");
    await settle();

    const previewRequest = requests.find((request) => request.url.includes("context-preview"));
    expect(previewRequest).toMatchObject({
      url: "/api/nodes/node-a/agents/context-preview",
      body: {
        atom_contexts: profile.atom_contexts,
        session: { source: "browser", agent: "seosoyoung" },
      },
    });
    const results = document.body.querySelector('[data-testid="context-preview-results"]');
    expect(results?.textContent).toContain("운영 지침");
    expect(results?.textContent).toContain("filtered");
    expect(results?.textContent).toContain("345");
    expect(results?.textContent).toContain("87");
  });

  async function renderEditor() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(createElement(AgentProfileEditorTab)));
    await settle();
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setInput(label: string, value: string) {
  const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input).not.toBeNull();
  flushSync(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButton(label: string) {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent === label);
  expect(button).not.toBeUndefined();
  flushSync(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function clickButtonByLabel(label: string) {
  const button = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  flushSync(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function profileButton(name: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>("aside button"))
    .find((candidate) => candidate.textContent?.includes(name));
  expect(button).not.toBeUndefined();
  return button as HTMLButtonElement;
}

function setSelect(label: string, value: string) {
  const select = document.body.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(select).not.toBeNull();
  flushSync(() => {
    if (select) select.value = value;
    select?.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function effectiveRows(): string[] {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('[data-testid="effective-context-row"]'),
    (row) => row.dataset.source ?? "",
  );
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
