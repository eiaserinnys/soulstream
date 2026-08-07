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
  atom_contexts: [{
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
    expect(document.body.textContent).toContain("프로필을 저장했습니다.");
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
        session: { source: "browser", container_kind: "task", agent: "seosoyoung" },
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

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
