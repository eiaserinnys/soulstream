/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoginSheet } from "./AgentLoginSheet";
import type { AgentLoginFlow, AgentLoginProvider } from "../../lib/agent-login-api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 이 시험의 일회용 코드와 주소는 가짜 값이다. 화면 밖으로 새지 않는지도 같은 값으로 본다.
const USER_CODE = "ABCD-1234";
const AUTH_URL = "https://auth.example.test/device?session=s-secret";
const PASTED_CODE = "pasted-secret-code-777";

type Call = { method: string; path: string; body: unknown };

function flow(state: AgentLoginFlow["state"], provider: AgentLoginProvider, patch: Partial<AgentLoginFlow> = {}): AgentLoginFlow {
  return {
    login_id: "login-1",
    provider,
    state,
    auth_url: null,
    user_code: null,
    expects_code: provider === "antigravity",
    expires_at: null,
    error: null,
    ...patch,
  };
}

/** 호출을 기록하고, 경로별로 다음 응답을 차례로 내주는 가짜 서버. 응답이 모자라면 마지막 응답을 반복한다. */
function fakeServer(responses: { post?: Array<AgentLoginFlow | Response>; get?: Array<AgentLoginFlow | Response>; code?: Array<AgentLoginFlow | Response>; del?: Array<AgentLoginFlow | Response> }) {
  const calls: Call[] = [];
  const cursor = { post: 0, get: 0, code: 0, del: 0 };
  const next = (key: keyof typeof cursor): Response => {
    const list = responses[key] ?? [];
    const item = list[Math.min(cursor[key], list.length - 1)];
    cursor[key] += 1;
    if (!item) throw new Error(`no scripted response for ${key}`);
    return item instanceof Response ? item : Response.json(item);
  };
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(input);
    calls.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (method === "POST" && /\/agent-logins\/(codex|antigravity)$/.test(path)) return next("post");
    if (method === "POST" && path.endsWith("/code")) return next("code");
    if (method === "GET") return next("get");
    if (method === "DELETE") return next("del");
    throw new Error(`unexpected ${method} ${path}`);
  }) as typeof fetch;
  return { request, calls, count: (method: string) => calls.filter((call) => call.method === method).length };
}

const errorResponse = (status: number, code: string) => Response.json({ code, message: `server says ${code}` }, { status });

let host: HTMLDivElement;
let root: Root;
let logged: unknown[][];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args); });
  }
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function open(provider: AgentLoginProvider, request: typeof fetch, handlers: { onClose?: () => void; onDone?: () => void } = {}) {
  await act(async () => root.render(<AgentLoginSheet nodeId="node 1" provider={provider} request={request} onClose={handlers.onClose ?? vi.fn()} onDone={handlers.onDone ?? vi.fn()} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
const tick = async (ms = 1000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const text = () => host.textContent ?? "";
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
const press = async (label: string) => { await act(async () => buttons().find((button) => button.textContent?.includes(label))!.click()); };
const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("AgentLoginSheet", () => {
  it("starts a Codex login for the node and shows the address button, the code, and the remaining time", async () => {
    const expires = new Date(Date.now() + 9 * 60_000 + 30_000).toISOString();
    const server = fakeServer({ post: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE, expires_at: expires })], get: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE, expires_at: expires })] });
    await open("codex", server.request);

    expect(server.calls[0]).toEqual({ method: "POST", path: "/api/nodes/node%201/agent-logins/codex", body: undefined });
    expect(text()).toContain("아래 주소를 열고 코드를 넣으세요");
    const link = host.querySelector<HTMLAnchorElement>("a[href]")!;
    expect(link.textContent).toContain("주소 열기");
    expect(link.getAttribute("href")).toBe(AUTH_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(host.querySelector('[data-testid="agent-login-user-code"]')?.textContent).toBe(USER_CODE);
    expect(host.querySelector('[data-testid="agent-login-remaining"]')?.textContent).toBe("남은 시간 9:30");
    await tick(1000);
    expect(host.querySelector('[data-testid="agent-login-remaining"]')?.textContent).toBe("남은 시간 9:29");
    // Codex는 코드 입력칸이 없다.
    expect(host.querySelector("input")).toBeNull();
  });

  it("copies the code with the copy button", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const server = fakeServer({ post: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE })], get: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE })] });
    await open("codex", server.request);
    await press("복사");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(USER_CODE);
  });

  it("polls every second while in progress and stops after done, notifying once", async () => {
    const onDone = vi.fn();
    const server = fakeServer({
      post: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE })],
      get: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE }), flow("verifying", "codex"), flow("done", "codex")],
    });
    await open("codex", server.request, { onDone });
    expect(server.count("GET")).toBe(0);
    await tick(999);
    expect(server.count("GET")).toBe(0);
    await tick(1);
    expect(server.count("GET")).toBe(1);
    await tick(1000);
    expect(text()).toContain("사용량을 확인하고 있습니다");
    expect(server.count("GET")).toBe(2);
    await tick(1000);
    expect(text()).toContain("연결되었습니다");
    expect(onDone).toHaveBeenCalledTimes(1);
    await tick(5000);
    expect(server.count("GET")).toBe(3);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it.each([["failed"], ["cancelled"]] as const)("stops polling at %s", async (state) => {
    const server = fakeServer({
      post: [flow("requested", "antigravity")],
      get: [flow(state, "antigravity", { error: state === "failed" ? { code: "timeout", message: "x" } : null })],
    });
    await open("antigravity", server.request);
    await tick(1000);
    expect(server.count("GET")).toBe(1);
    await tick(5000);
    expect(server.count("GET")).toBe(1);
  });

  it("asks Antigravity for the pasted code, posts it as the body, and clears the input right away", async () => {
    let releaseCode!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { releaseCode = resolve; });
    const server = fakeServer({ post: [flow("url_ready", "antigravity", { auth_url: AUTH_URL })], get: [flow("url_ready", "antigravity", { auth_url: AUTH_URL })] });
    const inner = server.request;
    const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/code")) {
        server.calls.push({ method: "POST", path: String(input), body: JSON.parse(String(init?.body)) });
        return pending;
      }
      return inner(input, init);
    }) as typeof fetch;
    await open("antigravity", request);

    expect(text()).toContain("브라우저가 보여 준 인증 코드를 붙여 넣으세요");
    expect(host.querySelector("a[href]")?.getAttribute("href")).toBe(AUTH_URL);
    expect(host.querySelector('[data-testid="agent-login-user-code"]')).toBeNull();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Antigravity 인증 코드"]')!;
    await typeInto(input, PASTED_CODE);
    expect(input.value).toBe(PASTED_CODE);
    await press("제출");

    expect(server.calls.at(-1)).toEqual({ method: "POST", path: "/api/nodes/node%201/agent-logins/login-1/code", body: { code: PASTED_CODE } });
    // 응답을 기다리는 동안에도 입력칸과 화면 어디에도 코드가 남지 않는다.
    expect(input.value).toBe("");
    expect(host.innerHTML).not.toContain(PASTED_CODE);
    await act(async () => releaseCode(Response.json(flow("verifying", "antigravity"))));
    expect(text()).toContain("사용량을 확인하고 있습니다");
    expect(host.innerHTML).not.toContain(PASTED_CODE);
    expect(JSON.stringify(logged)).not.toContain(PASTED_CODE);
  });

  it("ends an Antigravity login that rejected the pasted code as failed and starts a new flow with a new address on retry", async () => {
    const NEW_URL = "https://auth.example.test/device?session=second";
    const server = fakeServer({
      post: [flow("url_ready", "antigravity", { auth_url: AUTH_URL }), flow("url_ready", "antigravity", { login_id: "login-2", auth_url: NEW_URL })],
      code: [flow("failed", "antigravity", { error: { code: "invalid_code", message: "raw" } })],
      get: [flow("url_ready", "antigravity", { auth_url: AUTH_URL })],
    });
    await open("antigravity", server.request);
    await typeInto(host.querySelector<HTMLInputElement>("input")!, PASTED_CODE);
    await press("제출");

    expect(host.querySelector('[role="alert"]')?.textContent).toContain("인증 코드가 맞지 않습니다. 다시 시도하면 새 주소가 열립니다.");
    expect(host.querySelector("input")).toBeNull();
    expect(host.innerHTML).not.toContain(PASTED_CODE);
    // 같은 흐름에는 코드를 다시 넣을 수 없고, 읽기도 멈춘다.
    const readsAtFailure = server.count("GET");
    await tick(3000);
    expect(server.count("GET")).toBe(readsAtFailure);

    await press("다시 시도");
    expect(server.calls.filter((call) => call.method === "POST" && /agent-logins\/antigravity$/.test(call.path))).toHaveLength(2);
    expect(host.querySelector("a[href]")?.getAttribute("href")).toBe(NEW_URL);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>("input")?.value).toBe("");
    // 끝난 첫 흐름은 다시 취소하지 않는다.
    expect(server.count("DELETE")).toBe(0);
  });

  it("keeps one-time values out of the console, including on request failures", async () => {
    const server = fakeServer({ post: [flow("url_ready", "antigravity", { auth_url: AUTH_URL })], get: [flow("url_ready", "antigravity", { auth_url: AUTH_URL })], code: [errorResponse(409, "login_not_ready")] });
    await open("antigravity", server.request);
    await typeInto(host.querySelector<HTMLInputElement>("input")!, PASTED_CODE);
    await press("제출");
    expect(text()).toContain("아직 코드를 받을 수 있는 단계가 아닙니다");
    await tick(3000);
    const everything = JSON.stringify(logged);
    expect(everything).not.toContain(PASTED_CODE);
    expect(everything).not.toContain(AUTH_URL);
    expect(everything).not.toContain("s-secret");
  });

  it("cancels the login with DELETE when the sheet is closed from outside while in progress", async () => {
    const server = fakeServer({ post: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE })], get: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE })], del: [flow("cancelled", "codex")] });
    await open("codex", server.request);
    await act(async () => root.unmount());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(server.calls.filter((call) => call.method === "DELETE")).toEqual([{ method: "DELETE", path: "/api/nodes/node%201/agent-logins/login-1", body: undefined }]);
    root = createRoot(host);
  });

  it("does not cancel a finished login when the sheet goes away", async () => {
    const server = fakeServer({ post: [flow("done", "codex")], del: [flow("cancelled", "codex")] });
    await open("codex", server.request);
    await act(async () => root.unmount());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(server.count("DELETE")).toBe(0);
    root = createRoot(host);
  });

  it("cancels with the cancel button and then closes", async () => {
    const onClose = vi.fn();
    const server = fakeServer({ post: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE })], get: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE })], del: [flow("cancelled", "codex")] });
    await open("codex", server.request, { onClose });
    await press("취소");
    expect(server.count("DELETE")).toBe(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(server.count("DELETE")).toBe(1);
    root = createRoot(host);
  });

  it.each([
    ["device_code_disabled", "ChatGPT 설정의 보안 항목에서 Codex 기기 코드 인증을 켠 뒤 다시 시도해 주세요."],
    ["invalid_code", "인증 코드가 맞지 않습니다. 다시 시도하면 새 주소가 열립니다."],
    ["timeout", "제한 시간 안에 인증이 끝나지 않았습니다. 다시 시도해 주세요."],
    ["cli_exited", "Codex CLI가 로그인 도중 종료되었습니다. 다시 시도해 주세요."],
    ["verify_failed", "로그인은 끝났지만 Codex 사용량 확인을 통과하지 못했습니다. 계정과 구독 상태를 확인한 뒤 다시 시도해 주세요."],
    ["cancelled_by_new_login", "새 로그인 요청이 시작되어 이 로그인은 취소되었습니다."],
    ["something_new", "로그인을 완료하지 못했습니다. 다시 시도해 주세요."],
  ])("explains a failed login with code %s in Korean and offers a retry", async (code, expected) => {
    const server = fakeServer({ post: [flow("failed", "codex", { error: { code, message: "raw server text must not be shown" } })] });
    await open("codex", server.request);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(expected);
    expect(text()).not.toContain("raw server text must not be shown");
    server.calls.length = 0;
    await press("다시 시도");
    expect(server.calls[0]).toMatchObject({ method: "POST", path: "/api/nodes/node%201/agent-logins/codex" });
  });

  it.each([
    [409, "cli_not_installed", "이 노드에 Codex CLI가 없습니다."],
    [409, "agent_login_unsupported", "이 노드에 Codex CLI가 없습니다."],
    [404, "node_not_connected", "노드가 연결되어 있지 않습니다."],
    [403, "forbidden", "관리자만 코딩 에이전트를 연결할 수 있습니다."],
    [502, "worker_error", "노드의 워커가 요청을 처리하지 못했습니다."],
  ])("explains a start failure %i %s by status and code only", async (status, code, expected) => {
    const server = fakeServer({ post: [errorResponse(status, code)] });
    await open("codex", server.request);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(expected);
    expect(text()).not.toContain("server says");
    expect(buttons().some((button) => button.textContent?.includes("다시 시도"))).toBe(true);
  });

  it("starts the login once even when mounted twice in development", async () => {
    const { StrictMode } = await import("react");
    const server = fakeServer({ post: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE })], get: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE })], del: [flow("cancelled", "codex")] });
    await act(async () => root.render(<StrictMode><AgentLoginSheet nodeId="n" provider="codex" request={server.request} onClose={vi.fn()} onDone={vi.fn()} /></StrictMode>));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(server.count("POST")).toBe(1);
    expect(server.count("DELETE")).toBe(0);
  });

  it("refuses to link an authentication address that is not http or https", async () => {
    const server = fakeServer({ post: [flow("url_ready", "codex", { auth_url: "javascript:alert(1)", user_code: USER_CODE })], get: [flow("url_ready", "codex", { auth_url: "javascript:alert(1)", user_code: USER_CODE })] });
    await open("codex", server.request);
    expect(host.querySelector("a[href]")).toBeNull();
    expect(text()).toContain("인증 주소를 열 수 없습니다");
  });

  describe("focus", () => {
    const sheet = () => host.querySelector<HTMLElement>('[data-testid="agent-login-sheet"]')!;

    it("holds focus on the sheet while the login starts, then moves it to the address button", async () => {
      let release: (response: Response) => void = () => undefined;
      const server = fakeServer({ get: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE })], del: [flow("cancelled", "codex")] });
      const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "POST") return new Promise<Response>((resolve) => { release = resolve; });
        return server.request(input, init);
      }) as typeof fetch;
      await open("codex", slow);
      expect(document.activeElement).toBe(sheet());
      expect(text()).toContain("로그인을 준비하고 있습니다");
      await act(async () => { release(Response.json(flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE }))); });
      expect(document.activeElement).toBe(host.querySelector("a[href]"));
    });

    it("puts focus on the code input when Antigravity asks for a code", async () => {
      const server = fakeServer({ post: [flow("url_ready", "antigravity", { auth_url: AUTH_URL })], get: [flow("url_ready", "antigravity", { auth_url: AUTH_URL })] });
      await open("antigravity", server.request);
      expect(document.activeElement).toBe(host.querySelector("input"));
    });

    it("puts focus on the retry button when the login fails", async () => {
      const server = fakeServer({ post: [flow("failed", "codex", { error: { code: "timeout", message: "x" } })] });
      await open("codex", server.request);
      expect(document.activeElement?.textContent).toContain("다시 시도");
    });

    it("cancels the login and closes on Esc", async () => {
      const onClose = vi.fn();
      const server = fakeServer({ post: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE })], get: [flow("url_ready", "codex", { auth_url: AUTH_URL, user_code: USER_CODE })], del: [flow("cancelled", "codex")] });
      await open("codex", server.request, { onClose });
      await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(server.count("DELETE")).toBe(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
