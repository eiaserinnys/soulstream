/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeGitCloneJob, NodeGitSetupSnapshot } from "../../../packages/wire-schema/generated/typescript/index";
import type { OrchestratorNode } from "../store/orchestrator-store";
import { GitReposTab } from "./GitReposTab";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const node = (nodeId: string, status: "connected" | "disconnected" = "connected", capabilities: Record<string, unknown> = { node_git_setup_v1: true }): OrchestratorNode =>
  ({ nodeId, status, capabilities } as OrchestratorNode);
const nodes = (...list: OrchestratorNode[]) => new Map(list.map((item) => [item.nodeId, item]));

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyExampleKeyExampleKeyExample soulstream@n1";
const snapshot = (patch: Partial<NodeGitSetupSnapshot> = {}): NodeGitSetupSnapshot => ({
  identity: { name: "소영", email: "soyoung@example.com" },
  ssh: { state: "ready", key_path: "/home/eias/.ssh/id_ed25519", public_key: PUBLIC_KEY },
  projects: {
    state: "ready",
    root: "/home/eias/workspace/.projects",
    repos: [
      { name: "soulstream", origin_url: "git@github.com:eiaserinnys/soulstream.git", branch: "main", dirty: true },
      { name: "atom", origin_url: null, branch: null, dirty: false },
    ],
  },
  clone: null,
  ...patch,
});
const cloneJob = (patch: Partial<NodeGitCloneJob> = {}): NodeGitCloneJob => ({
  clone_id: "clone-1", repo_name: "newrepo", url: "git@github.com:o/newrepo.git", state: "running", error: null,
  started_at: "2026-11-27T00:00:00.000Z", finished_at: null, ...patch,
});

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let responder: (call: Call) => Response | Promise<Response>;
const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const call = { method: init?.method ?? "GET", path: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined };
  calls.push(call);
  return responder(call);
}) as typeof fetch;
const json = (body: unknown, status = 200) => Response.json(body, { status });
const reads = (path: string) => calls.filter((call) => call.method === "GET" && call.path === path).length;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  calls = [];
  responder = () => json(snapshot());
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const settle = async (ms = 20) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const render = async (sample: Map<string, OrchestratorNode>) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><GitReposTab sampleNodes={sample} request={request} /></QueryClientProvider>));
  await settle();
};
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === name)!;
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const press = async (name: string) => { await act(async () => button(name).click()); await settle(); };
const type = async (label: string, value: string) => act(async () => {
  const element = input(label);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
});
const text = () => host.textContent ?? "";

describe("GitReposTab", () => {
  it("opens with the first connected node selected and reads its Git state", async () => {
    await render(nodes(node("down", "disconnected"), node("n1")));
    expect([...host.querySelectorAll("aside button")].map((row) => row.textContent)).toEqual(["down연결 끊김", "n1연결됨"]);
    expect(calls).toEqual([{ method: "GET", path: "/api/nodes/n1/git", body: undefined }]);
    expect(text()).toContain("Git 사용자");
    expect(input("이름").value).toBe("소영");
    expect(input("이메일").value).toBe("soyoung@example.com");
  });

  it("shows only a notice and sends no request for a disconnected node", async () => {
    await render(nodes(node("down", "disconnected")));
    expect(text()).toContain("노드가 연결되어 있지 않습니다.");
    expect(calls).toEqual([]);
  });

  it("shows only an update notice and sends no request for a node without the capability", async () => {
    await render(nodes(node("old", "connected", {})));
    expect(text()).toContain("이 노드를 업데이트하면 쓸 수 있습니다.");
    expect(calls).toEqual([]);
  });

  it("shows loading in place, then an error with a reload that asks again", async () => {
    let release: (response: Response) => void = () => undefined;
    responder = () => new Promise<Response>((resolve) => { release = resolve; });
    await render(nodes(node("n1")));
    expect(host.querySelector('[data-slot="frame-loading"]')?.textContent).toContain("불러오는 중…");
    await act(async () => release(json({ code: "node_command_timeout", message: "x" }, 502)));
    await settle();
    expect(text()).toContain("Git 설정을 불러오지 못했습니다.");
    expect(host.querySelector('[data-slot="frame-loading"]')).toBeNull();
    responder = () => json(snapshot());
    await press("다시 불러오기");
    expect(reads("/api/nodes/n1/git")).toBe(2);
    expect(text()).toContain("Git 사용자");
  });

  it("lists repositories with origin, branch and the changed marker", async () => {
    await render(nodes(node("n1")));
    expect(text()).toContain("/home/eias/workspace/.projects");
    const rows = [...host.querySelectorAll("li")];
    expect(rows.map((row) => row.textContent)).toEqual([
      "soulstreammain변경 있음git@github.com:eiaserinnys/soulstream.git",
      "atom",
    ]);
    expect(host.querySelector('li p[title="git@github.com:eiaserinnys/soulstream.git"]')).not.toBeNull();
  });

  it("saves the identity with a PUT and shows a field error for a 422", async () => {
    await render(nodes(node("n1")));
    responder = () => json(snapshot({ identity: { name: "새 이름", email: "new@example.com" } }));
    await type("이름", "새 이름");
    await type("이메일", "new@example.com");
    await press("저장");
    expect(calls.at(-1)).toEqual({ method: "PUT", path: "/api/nodes/n1/git/identity", body: { name: "새 이름", email: "new@example.com" } });
    expect(text()).toContain("저장했습니다");
    responder = () => json({ code: "invalid_request", message: "x", field: "email" }, 422);
    await press("저장");
    expect(text()).toContain("이메일 주소를 확인하세요.");
    expect(text()).not.toContain("저장했습니다");
  });

  it("creates a missing SSH key and moves focus to the copy button", async () => {
    responder = () => json(snapshot({ ssh: { state: "missing", key_path: "/home/eias/.ssh/id_ed25519", public_key: null } }));
    await render(nodes(node("n1")));
    expect(host.textContent).not.toContain(PUBLIC_KEY);
    responder = () => json(snapshot(), 201);
    await press("SSH 키 만들기");
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/nodes/n1/git/ssh-key", body: undefined });
    expect(text()).toContain(PUBLIC_KEY);
    expect(button("SSH 키 만들기")).toBeUndefined();
    expect(document.activeElement).toBe(button("복사"));
  });

  it("offers no create button when only the public key file is missing", async () => {
    responder = () => json(snapshot({ ssh: { state: "public_missing", key_path: "/home/eias/.ssh/id_ed25519", public_key: null } }));
    await render(nodes(node("n1")));
    expect(text()).toContain("공개키 파일(id_ed25519.pub)이 없습니다.");
    expect(button("SSH 키 만들기")).toBeUndefined();
  });

  it("copies the public key", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await render(nodes(node("n1")));
    await press("복사");
    expect(writeText).toHaveBeenCalledWith(PUBLIC_KEY);
    expect(button("복사됨")).toBeDefined();
    vi.unstubAllGlobals();
  });

  it("checks the connection and shows a short status with the raw output folded away, or the failure with its detail", async () => {
    await render(nodes(node("n1")));
    expect(input("호스트").value).toBe("github.com");
    responder = () => json({ host: "github.com", ok: true, reason: "connected", output: "Hi soyoung! You've successfully authenticated" });
    await press("연결 확인");
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/nodes/n1/git/ssh-check", body: { host: "github.com" } });
    expect(host.querySelector('[role="status"]')?.textContent?.trim()).toBe("연결됨");
    expect(host.querySelector("details summary")?.textContent).toBe("기술 상세");
    expect(host.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(host.querySelector("details pre")?.textContent).toBe("Hi soyoung! You've successfully authenticated");
    expect(host.querySelector('[role="status"]')?.textContent).not.toContain("Hi soyoung!");
    responder = () => json({ host: "github.com", ok: false, reason: "auth_failed", output: "git@github.com: Permission denied (publickey)." });
    await press("연결 확인");
    expect(text()).toContain("공개키가 저장소 서비스에 등록되어 있지 않습니다.");
    expect(host.querySelector(".v3-error-notice pre")?.textContent).toBe("git@github.com: Permission denied (publickey).");
    expect(text()).not.toContain("Hi soyoung!");
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it("clones, polls until done, then reads the status again and lists the new repository", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await render(nodes(node("n1")));
    let statusReads = 0;
    responder = (call) => {
      if (call.method === "POST") return json(cloneJob(), 202);
      if (call.path.endsWith("/clones/clone-1")) return json(++statusReads < 2 ? cloneJob() : cloneJob({ state: "done", finished_at: "2026-11-27T00:00:05.000Z" }));
      return json(snapshot({ projects: { state: "ready", root: "/r", repos: [{ name: "newrepo", origin_url: null, branch: "main", dirty: false }] } }));
    };
    await type("원격 주소", "git@github.com:o/newrepo.git");
    await press("가져오기");
    expect(calls.find((call) => call.method === "POST")).toEqual({ method: "POST", path: "/api/nodes/n1/git/clones", body: { url: "git@github.com:o/newrepo.git" } });
    expect(host.querySelector('[data-slot="frame-loading"]')?.textContent).toContain("가져오는 중…");
    for (let step = 0; step < 4; step += 1) await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(text()).toContain("가져왔습니다: newrepo");
    expect(host.querySelector('[data-slot="frame-loading"]')).toBeNull();
    expect(reads("/api/nodes/n1/git")).toBe(2);
    expect([...host.querySelectorAll("li")].map((row) => row.textContent)).toEqual(["newrepomain"]);
  });

  it("shows an error with a retry when the clone status read fails, and finishes after the retry succeeds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await render(nodes(node("n1")));
    let statusFails = true;
    responder = (call) => {
      if (call.method === "POST") return json(cloneJob(), 202);
      if (call.path.endsWith("/clones/clone-1")) return statusFails ? json({ code: "node_command_timeout", message: "timeout" }, 504) : json(cloneJob({ state: "done", finished_at: "2026-11-27T00:00:05.000Z" }));
      return json(snapshot({ projects: { state: "ready", root: "/r", repos: [{ name: "newrepo", origin_url: null, branch: "main", dirty: false }] } }));
    };
    await type("원격 주소", "git@github.com:o/newrepo.git");
    await press("가져오기");
    await settle(50);
    const notice = host.querySelector(".v3-error-notice");
    expect(notice?.textContent).toContain("가져오기 진행 상태를 확인하지 못했습니다.");
    expect(host.querySelector('[data-slot="frame-loading"]')).toBeNull();
    expect(notice?.querySelector("button")?.textContent).toBe("다시 확인");
    statusFails = false;
    await press("다시 확인");
    await settle(50);
    expect(host.querySelector(".v3-error-notice")).toBeNull();
    expect(text()).toContain("가져왔습니다: newrepo");
    expect([...host.querySelectorAll("li")].map((row) => row.textContent)).toEqual(["newrepomain"]);
  });

  it("keeps the clone in progress when the user looks at another node and comes back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await render(nodes(node("n1"), node("n2")));
    let finished = false;
    responder = (call) => {
      if (call.method === "POST") return json(cloneJob(), 202);
      if (call.path.endsWith("/clones/clone-1")) return json(finished ? cloneJob({ state: "done", finished_at: "2026-11-27T00:00:05.000Z" }) : cloneJob());
      if (call.path === "/api/nodes/n1/git" && finished) return json(snapshot({ projects: { state: "ready", root: "/r", repos: [{ name: "newrepo", origin_url: null, branch: "main", dirty: false }] } }));
      return json(snapshot());
    };
    await type("원격 주소", "git@github.com:o/newrepo.git");
    await press("가져오기");
    const row = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("aside button")].find((item) => item.textContent?.startsWith(name))!;
    await act(async () => row("n2").click());
    await settle();
    expect(host.querySelector('[data-slot="frame-loading"]')).toBeNull();
    await act(async () => row("n1").click());
    await settle();
    expect(host.querySelector('[data-slot="frame-loading"]')?.textContent).toContain("가져오는 중…");
    finished = true;
    for (let step = 0; step < 3; step += 1) await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(text()).toContain("가져왔습니다: newrepo");
    expect([...host.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["newrepomain"]);
  });

  it("sends the folder name when given and shows a failed clone with its code text and detail", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await render(nodes(node("n1")));
    const failed = cloneJob({ url: "https://github.com/o/private.git", state: "failed", error: { code: "auth_failed", message: "x", detail: "fatal: could not read Username" } });
    responder = (call) => call.method === "POST" ? json(failed, 202) : json(failed);
    await type("원격 주소", "https://github.com/o/private.git");
    await type("폴더 이름", "private");
    await press("가져오기");
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ url: "https://github.com/o/private.git", repo_name: "private" });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(text()).toContain("인증에 실패했습니다.");
    expect(text()).toContain("비공개 저장소는 SSH 주소(git@…)로 가져오세요.");
    expect(host.querySelector(".v3-error-notice pre")?.textContent).toBe("fatal: could not read Username");
  });

  it("tells when the projects folder is not set or missing", async () => {
    responder = () => json(snapshot({ projects: { state: "root_unset", root: null, repos: [] } }));
    await render(nodes(node("n1")));
    expect(text()).toContain("저장소 폴더(WORKTREE_PROJECTS_ROOT)가 정해지지 않은 노드입니다.");
    expect(button("가져오기")).toBeUndefined();
    responder = () => json(snapshot({ projects: { state: "root_missing", root: "/nope", repos: [] } }));
    await act(async () => root.unmount());
    root = createRoot(host);
    await render(nodes(node("n1")));
    expect(text()).toContain("저장소 폴더가 없습니다: /nope");
  });
});
