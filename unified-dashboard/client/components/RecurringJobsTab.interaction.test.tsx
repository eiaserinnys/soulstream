/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({ openSession: vi.fn() }));

vi.mock("@seosoyoung/soul-ui", async () => {
  const React = await import("react");
  return {
    Button: ({ children, variant: _variant, size: _size, ...props }: any) => React.createElement("button", props, children),
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
    Select: ({ children }: any) => React.createElement(React.Fragment, null, children),
    SelectTrigger: ({ children }: any) => React.createElement("button", { type: "button" }, children),
    SelectPopup: ({ children }: any) => React.createElement("div", null, children),
    SelectItem: ({ children }: any) => React.createElement("div", null, children),
    useDashboardStore: (selector: any) => selector({
      catalog: { folders: [{ id: "folder-a", name: "음악" }] },
      setActiveSession: shared.openSession,
    }),
    useTaskStore: (selector: any) => selector({
      overview: { snapshot: { tasks: [] } },
      loadOverview: async () => undefined,
    }),
  };
});

vi.mock("../v3/AgentNodeAssignmentFields", async () => {
  const React = await import("react");
  return {
    AgentNodeAssignmentFields: ({ nodeId, agentId, onNodeIdChange, onAgentIdChange }: any) => React.createElement(
      "div",
      null,
      React.createElement("input", { "aria-label": "노드", value: nodeId, onChange: (event: any) => onNodeIdChange(event.target.value) }),
      React.createElement("input", { "aria-label": "에이전트", value: agentId, onChange: (event: any) => onAgentIdChange(event.target.value) }),
    ),
  };
});

import { RecurringJobsTab } from "./RecurringJobsTab";

describe("RecurringJobsTab lifecycle", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    container?.remove();
    document.body.innerHTML = "";
    root = undefined;
    container = undefined;
    shared.openSession.mockReset();
    vi.unstubAllGlobals();
  });

  it("registers, edits, pauses, resumes, refreshes, and opens the durable run session", async () => {
    let job: Record<string, any> | null = null;
    const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
    const run = {
      run_id: "run-1", job_id: "job-1", trigger: "scheduled", scheduled_for: "2026-09-22T00:00:00.000Z",
      session_id: "session-1", state: "succeeded", reason_code: null, reason_message: null, job_snapshot: {},
      created_at: "2026-09-22T00:00:00.000Z", started_at: null, finished_at: null, updated_at: "2026-09-22T00:00:00.000Z",
    };
    vi.stubGlobal("crypto", { randomUUID: () => "test-id" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ path, method, body });
      if (path.endsWith("/runs?limit=50")) return json({ runs: job ? [run] : [] });
      if (path === "/api/recurring-jobs?include_archived=true") return json({ jobs: job ? [job] : [] });
      if (path === "/api/recurring-jobs" && method === "POST") {
        job = {
          ...body, job_id: "job-1", version: 1, archived_at: null, next_run_at: "2026-09-22T00:00:00.000Z",
          created_at: "2026-09-21T00:00:00.000Z", updated_at: "2026-09-21T00:00:00.000Z",
        };
        return json({ job });
      }
      if (path === "/api/recurring-jobs/job-1" && method === "PATCH") {
        job = { ...job, ...body, version: Number(job?.version ?? 0) + 1 };
        return json({ job });
      }
      throw new Error(`unexpected request ${method} ${path}`);
    }));

    await renderTab();
    setInput("작업 이름", "음악 추천");
    setInput("작업 내용", "기존 음악 추천 지시문을 실행한다.");
    setInput("노드", "eiaserinnys");
    setInput("에이전트", "seosoyoung");
    setSelect("결과 폴더", "folder-a");
    clickButton("반복 작업 생성");
    await waitFor(() => {
      if (!requests.some((request) => request.method === "POST" && request.path === "/api/recurring-jobs")) {
        throw new Error(document.body.textContent ?? "POST 요청이 시작되지 않았습니다.");
      }
    });

    const create = requests.find((request) => request.method === "POST" && request.path === "/api/recurring-jobs");
    expect(create?.body).toMatchObject({
      schedule_expressions: ["0 9 * * 1-5"],
      folder_id: "folder-a",
      container: { kind: "folder", id: "folder-a" },
    });
    expect(document.body.textContent).not.toContain("결과 폴더 ID");
    expect(document.body.textContent).not.toContain("결과 컨테이너 ID");

    await waitFor(() => expect(document.body.textContent).toContain("변경 저장"));
    setInput("작업 이름", "음악 추천 수정");
    clickButton("변경 저장");
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH" && request.body?.name === "음악 추천 수정")).toBe(true));
    await waitFor(() => expect(button("일시정지")?.disabled).toBe(false));
    clickButton("일시정지");
    await waitFor(() => expect(document.body.textContent).toContain("재개"));
    await waitFor(() => expect(button("재개")?.disabled).toBe(false));
    clickButton("재개");
    await waitFor(() => expect(document.body.textContent).toContain("일시정지"));
    clickButton("새로고침");
    await waitFor(() => expect(requests.filter((request) => request.path.endsWith("/runs?limit=50")).length).toBeGreaterThan(1));
    clickButton("세션 열기");
    expect(shared.openSession).toHaveBeenCalledWith("session-1");
  });

  it("reloads the durable version after a save conflict without discarding the draft", async () => {
    const initial = recurringJob({ version: 4, name: "음악 추천" });
    const latest = recurringJob({ version: 5, name: "다른 사용자의 변경" });
    let listCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/recurring-jobs?include_archived=true") {
        listCount += 1;
        return json({ jobs: [listCount === 1 ? initial : latest] });
      }
      if (path.endsWith("/runs?limit=50")) return json({ runs: [] });
      if (path === "/api/recurring-jobs/job-1" && init?.method === "PATCH") {
        return json({ detail: "version conflict" }, 409);
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${path}`);
    }));

    await renderTab();
    await waitFor(() => expect(buttonContaining("음악 추천")).toBeDefined());
    flushSync(() => buttonContaining("음악 추천")?.click());
    await waitFor(() => expect(document.body.textContent).toContain("변경 저장"));
    setInput("작업 이름", "보존할 초안");
    clickButton("변경 저장");

    await waitFor(() => expect(document.body.textContent).toContain("다른 변경을 반영했습니다. 입력은 보존했습니다. 최신 버전으로 다시 저장하세요."));
    expect((document.body.querySelector('[aria-label="작업 이름"]') as HTMLInputElement).value).toBe("보존할 초안");
    expect(listCount).toBeGreaterThanOrEqual(2);
  });

  async function renderTab() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(createElement(RecurringJobsTab)));
    await settle();
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recurringJob(patch: Partial<Record<string, unknown>> = {}) {
  return {
    job_id: "job-1", name: "음악 추천", prompt: "기존 지시문", timezone: "Asia/Seoul",
    schedule_expressions: ["0 9 * * 1-5"], node_id: "node-a", agent_id: "agent-a", model_preset: null,
    folder_id: "folder-a", container: { kind: "folder", id: "folder-a" }, late_run_window_seconds: 1_800,
    enabled: true, archived_at: null, next_run_at: "2026-09-22T00:00:00.000Z", version: 1,
    created_at: "2026-09-21T00:00:00.000Z", updated_at: "2026-09-21T00:00:00.000Z",
    ...patch,
  };
}

function setInput(label: string, value: string) {
  const input = document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  expect(input).not.toBeNull();
  flushSync(() => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
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
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent === label);
}

function buttonContaining(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.includes(label));
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
