/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@seosoyoung/soul-ui", async () => {
  const React = await import("react");
  return {
    cn: (...parts: unknown[]) => parts.filter(Boolean).join(" "),
    Button: ({ children, variant: _variant, size: _size, ...props }: any) => React.createElement("button", props, children),
    Input: ({ nativeInput: _native, ...props }: any) => React.createElement("input", props),
    NewSessionFolderSelector: ({ folders, selectedFolderId, onFolderChange, label }: any) => React.createElement(
      "label",
      null,
      label,
      React.createElement("select", {
        "aria-label": label,
        value: selectedFolderId ?? "",
        onChange: (event: any) => onFolderChange(event.target.value || null),
      }, [React.createElement("option", { key: "empty", value: "" }, "폴더를 선택하세요"), ...folders.map((folder: any) => React.createElement("option", { key: folder.id, value: folder.id }, folder.name))]),
    ),
    useDashboardStore: (selector: any) => selector({ catalog: { folders: [{ id: "folder-a", name: "음악" }] } }),
  };
});

vi.mock("../v3/AgentSelectionField", async () => {
  const React = await import("react");
  return {
    AgentSelectionField: ({ value, disabled, onChange }: any) => React.createElement("select", {
      "aria-label": "에이전트 선택", value, disabled, onChange: (event: any) => onChange(event.target.value),
    }, [React.createElement("option", { key: "", value: "" }, "미지정"), React.createElement("option", { key: "agent-a", value: "agent-a" }, "에이전트 A")]),
  };
});

vi.mock("./NodeModelPresetSelect", async () => {
  const React = await import("react");
  return {
    NodeModelPresetSelect: ({ value, disabled, onValueChange }: any) => React.createElement("select", {
      "aria-label": "기본 모델", value, disabled, onChange: (event: any) => onValueChange(event.target.value),
    }, ["", "preset-a", "preset-b"].map((id) => React.createElement("option", { key: id, value: id }, id || "미지정"))),
  };
});

import { PersistentSessionsTab } from "./PersistentSessionsTab";

const BLANK_MESSAGE = "서버가 정한 빈 첫 메시지 문장";

describe("PersistentSessionsTab", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    container?.remove();
    document.body.innerHTML = "";
    root = undefined;
    container = undefined;
    vi.restoreAllMocks();
  });

  it("shows a load failure with a retry instead of an empty list", async () => {
    let attempts = 0;
    const { request } = server({ onList: () => (attempts += 1) === 1 ? failure(503, "NODE_UNAVAILABLE", "목록을 읽지 못했습니다.") : undefined });
    await renderTab(request);
    await waitFor(() => expect(document.body.textContent).toContain("목록을 읽지 못했습니다."));
    expect(document.body.textContent).not.toContain("등록된 영구 에이전트 세션이 없습니다.");
    expect(button("세션 추가")).toBeUndefined();
    clickButton("다시 시도");
    await waitFor(() => expect(document.body.textContent).toContain("서소영 관제"));
    expect(document.body.textContent).not.toContain("목록을 읽지 못했습니다.");
  });

  it("saves only the name and default model, keeps the recorded effort, and shows the saved values after re-reading", async () => {
    const { request, calls } = server();
    await renderTab(request);
    await waitFor(() => expect(buttonContaining("리뷰 관제")).toBeDefined());
    flushSync(() => buttonContaining("리뷰 관제")?.click());
    await waitFor(() => expect(nameInput().value).toBe("리뷰 관제"));
    expect(inputValues()).toContain("대기 변경 없음");

    setInput(nameInput(), "리뷰 관제 수정");
    clickButton("변경 저장");
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    // 기본 모델을 그대로 둔 저장은 기록된 추론 수준을 보존하고 숨은 설정은 보내지 않는다.
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      display_name: "리뷰 관제 수정",
      settings: { default_model: { model_preset: "preset-a", reasoning_effort: "high" } },
    });
    await waitFor(() => expect(document.body.textContent).toContain("리뷰 관제 수정"));

    setSelect("기본 모델", "preset-b");
    clickButton("변경 저장");
    await waitFor(() => expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2));
    expect(calls.filter((call) => call.method === "PUT")[1]?.body).toEqual({
      display_name: "리뷰 관제 수정",
      settings: { default_model: { model_preset: "preset-b", reasoning_effort: null } },
    });
    await waitFor(() => expect(inputValues()).toContain("다음 실행부터 preset-b"));

    clickButton("새로고침");
    await waitFor(() => expect(calls.filter((call) => call.method === "GET").length).toBeGreaterThan(1));
    expect(nameInput().value).toBe("리뷰 관제 수정");
    expect((document.body.querySelector('[aria-label="기본 모델"]') as HTMLSelectElement).value).toBe("preset-b");
  });

  it("blocks buttons while saving and keeps the input after a failure so it can be saved again", async () => {
    let release!: () => void;
    let attempts = 0;
    const { request, calls } = server({
      onUpdate: () => {
        attempts += 1;
        if (attempts === 1) return new Promise<Response>((resolve) => { release = () => resolve(failure(503, "NODE_UNAVAILABLE", "노드가 응답하지 않습니다.")); });
        return undefined;
      },
    });
    await renderTab(request);
    await waitFor(() => expect(buttonContaining("리뷰 관제")).toBeDefined());
    flushSync(() => buttonContaining("리뷰 관제")?.click());
    await waitFor(() => expect(nameInput().value).toBe("리뷰 관제"));
    setInput(nameInput(), "초안 이름");
    clickButton("변경 저장");
    await waitFor(() => expect(button("저장 중...")).toBeDefined());
    expect(button("저장 중...")?.disabled).toBe(true);
    expect(button("영구 세션 해제")?.disabled).toBe(true);
    release();
    await waitFor(() => expect(document.body.textContent).toContain("노드가 응답하지 않습니다. 일부 변경이 저장됐을 수 있습니다. 다시 읽거나 저장해 주세요."));
    expect(nameInput().value).toBe("초안 이름");
    expect(button("변경 저장")?.disabled).toBe(false);
    clickButton("변경 저장");
    await waitFor(() => expect(document.body.textContent).not.toContain("노드가 응답하지 않습니다."));
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2);
  });

  it("offers a re-save when the default model differs from the running model and no change is pending", async () => {
    const { request } = server({ sessions: [session({ session_id: "s-1", display_name: "서소영 관제", defaultModel: "preset-b", currentModel: "preset-a" })] });
    await renderTab(request);
    await waitFor(() => expect(buttonContaining("서소영 관제")).toBeDefined());
    flushSync(() => buttonContaining("서소영 관제")?.click());
    await waitFor(() => expect(document.body.textContent).toContain("기본 모델 변경 요청이 없습니다. 다시 저장해 주세요."));
    expect(button("변경 저장")?.disabled).toBe(false);
  });

  it("adds a session with the server's blank-message sentence only as a placeholder", async () => {
    const { request, calls } = server({ sessions: [], defaults: { preferred_agent_id: "agent-a" } });
    await renderTab(request);
    await waitFor(() => expect(document.body.textContent).toContain("등록된 영구 에이전트 세션이 없습니다."));
    expect((document.body.querySelector('[aria-label="첫 메시지 (선택)"]') as HTMLTextAreaElement).placeholder).toBe(BLANK_MESSAGE);
    setInput(nameInput(), "새 세션 이름");
    setSelect("생성 폴더", "folder-a");
    clickButton("세션 추가");
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      display_name: "새 세션 이름",
      agent_id: "agent-a",
      folder_id: "folder-a",
      initial_instruction: "",
      settings: { default_model: { model_preset: "preset-a", reasoning_effort: null } },
    });
    await waitFor(() => expect(button("영구 세션 해제")).toBeDefined());
    expect(document.body.textContent).toContain("새 세션 이름");
  });

  it("keeps add disabled until a real default model is chosen", async () => {
    const { request } = server({ sessions: [], defaults: { model_preset: null } });
    await renderTab(request);
    await waitFor(() => expect(button("세션 추가")).toBeDefined());
    expect(button("세션 추가")?.disabled).toBe(true);
    setSelect("기본 모델", "preset-b");
    expect(button("세션 추가")?.disabled).toBe(false);
  });

  it("retries only the registration for a created session after a registration failure", async () => {
    let posts = 0;
    const { request, calls } = server({
      sessions: [],
      defaults: { preferred_agent_id: "agent-a" },
      onCreate: () => {
        posts += 1;
        return failure(503, "PERSISTENT_REGISTRATION_FAILED", "등록 실패", { created_session: { session_id: "made-1", display_name: "새 세션 이름" } });
      },
    });
    await renderTab(request);
    await waitFor(() => expect(button("세션 추가")).toBeDefined());
    setInput(nameInput(), "새 세션 이름");
    setSelect("생성 폴더", "folder-a");
    clickButton("세션 추가");
    await waitFor(() => expect(document.body.textContent).toContain("세션은 만들어졌으나 등록하지 못했습니다."));
    expect(document.body.textContent).toContain("“새 세션 이름”");
    expect(button("세션 추가")).toBeUndefined();
    expect(nameInput().value).toBe("새 세션 이름");

    clickButton("등록 다시 시도");
    await waitFor(() => expect(calls.some((call) => call.method === "PUT" && call.path === "/api/persistent-sessions/made-1")).toBe(true));
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      display_name: "새 세션 이름",
      enabled: true,
      settings: { default_model: { model_preset: "preset-a", reasoning_effort: null } },
    });
    expect(posts).toBe(1);
    await waitFor(() => expect(button("영구 세션 해제")).toBeDefined());
    expect(document.body.textContent).not.toContain("세션은 만들어졌으나 등록하지 못했습니다.");
  });

  it("releases a session only after the confirm dialog and removes it from the list", async () => {
    const { request, calls } = server();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await renderTab(request);
    await waitFor(() => expect(buttonContaining("리뷰 관제")).toBeDefined());
    flushSync(() => buttonContaining("리뷰 관제")?.click());
    await waitFor(() => expect(button("영구 세션 해제")).toBeDefined());

    clickButton("영구 세션 해제");
    expect(confirm.mock.calls[0]?.[0]).toContain("세션과 대화 기록은 남습니다.");
    expect(calls.some((call) => call.method === "PUT")).toBe(false);

    clickButton("영구 세션 해제");
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ enabled: false });
    await waitFor(() => expect(document.body.textContent).not.toContain("리뷰 관제"));
    expect(document.body.textContent).toContain("서소영 관제");
  });

  async function renderTab(request: typeof fetch) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(createElement(PersistentSessionsTab, { request })));
    await settle();
  }
});

type ServerOptions = {
  sessions?: ReturnType<typeof session>[];
  defaults?: { preferred_agent_id?: string | null; model_preset?: string | null };
  onList?: () => Response | undefined;
  onUpdate?: () => Promise<Response> | Response | undefined;
  onCreate?: () => Response | undefined;
};

function session({ session_id, display_name, defaultModel = "preset-a", currentModel = "preset-a", pending = null }: {
  session_id: string; display_name: string; defaultModel?: string; currentModel?: string;
  pending?: { target_model_preset: string; target_reasoning_effort: string | null } | null;
}) {
  return {
    session_id, display_name, node_id: "node-a", folder_id: "folder-a", agent_id: "agent-a", agent_name: "에이전트 A", persistent: true,
    settings: { default_model: { model_preset: defaultModel, reasoning_effort: "high" }, fallback_model: null, show_generation_separator: true, show_character: true },
    runtime: { current_model: { model_preset: currentModel, reasoning_effort: "high", model: `${currentModel}-model` }, pending },
  };
}

/** 저장 뒤 목록이 저장값을 돌려주는 정도의 전송 모의. 실제 서버 저장의 증거가 아니다. */
function server(options: ServerOptions = {}) {
  const sessions = options.sessions ?? [
    session({ session_id: "s-1", display_name: "서소영 관제" }),
    session({ session_id: "s-2", display_name: "리뷰 관제" }),
  ];
  const calls: Array<{ path: string; method: string; body?: Record<string, any> }> = [];
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, any> : undefined;
    if (path === "/api/nodes/node-a/agents") return json({ agents: [{ id: "agent-a", name: "에이전트 A" }] });
    calls.push({ path, method, body });
    if (path === "/api/persistent-sessions" && method === "GET") {
      const early = options.onList?.();
      if (early) return early;
      const active = sessions.filter((item) => item.persistent);
      return json({
        sessions: active, total: active.length,
        create_defaults: {
          node_id: "node-a",
          preferred_agent_id: options.defaults?.preferred_agent_id ?? null,
          settings: {
            default_model: { model_preset: options.defaults && "model_preset" in options.defaults ? options.defaults.model_preset : "preset-a", reasoning_effort: null },
            fallback_model: null, show_generation_separator: true, show_character: true,
          },
          initial_instruction: BLANK_MESSAGE,
          unavailable_reason: null,
        },
      });
    }
    if (path === "/api/persistent-sessions" && method === "POST") {
      const early = options.onCreate?.();
      if (early) return early;
      const created = session({ session_id: "made-1", display_name: body?.display_name, defaultModel: body?.settings.default_model.model_preset, currentModel: body?.settings.default_model.model_preset });
      sessions.push(created);
      return json({ session: created, creation: "started", warnings: [] }, 201);
    }
    const target = sessions.find((item) => path === `/api/persistent-sessions/${item.session_id}`);
    if (method === "PUT") {
      const early = await options.onUpdate?.();
      if (early) return early;
      const saved = target ?? session({ session_id: path.split("/").pop()!, display_name: body?.display_name ?? "" });
      if (!target) sessions.push(saved);
      if (body?.enabled === false) { saved.persistent = false; return json({ session: saved, model_change: "none" }); }
      if (body?.enabled === true) saved.persistent = true;
      if (body?.display_name) saved.display_name = body.display_name;
      const requested = body?.settings?.default_model;
      let change = "none";
      if (requested) {
        saved.settings.default_model = { model_preset: requested.model_preset, reasoning_effort: requested.reasoning_effort ?? "high" };
        if (requested.model_preset !== saved.runtime.current_model.model_preset) {
          saved.runtime.pending = { target_model_preset: requested.model_preset, target_reasoning_effort: null };
          change = "next_execution_start";
        }
      }
      return json({ session: saved, model_change: change });
    }
    throw new Error(`unexpected request ${method} ${path}`);
  }) as typeof fetch;
  return { request, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function failure(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: { code, message }, ...extra }, status);
}

/** 읽기 전용 값은 입력 칸의 value로 보인다. */
function inputValues(): string[] {
  return Array.from(document.body.querySelectorAll("input")).map((input) => input.value);
}

function nameInput(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>('[data-testid="config-field-row"] input');
  expect(input).not.toBeNull();
  return input!;
}

function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  flushSync(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelect(label: string, value: string) {
  const select = document.body.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(select).not.toBeNull();
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select?.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function clickButton(label: string) {
  const target = button(label);
  expect(target).not.toBeUndefined();
  flushSync(() => target?.click());
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((candidate) => candidate.textContent === label);
}

function buttonContaining(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((candidate) => candidate.textContent?.includes(label));
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let index = 0; index < 40; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await settle();
    }
  }
  throw lastError;
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}
