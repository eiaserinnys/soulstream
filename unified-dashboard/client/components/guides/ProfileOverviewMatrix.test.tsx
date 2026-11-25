/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetGuideSession, type ContextOverview, type OverviewDocument, type OverviewProfile, type OverviewSource } from "../../lib/skill-guides";
import { ProfileOverviewMatrix } from "./ProfileOverviewMatrix";

const doc = (node_id: string, card_id: string, depth = 1): OverviewDocument => ({ node_id, card_id, title: node_id, depth, chars: 10 });
const source = (node_id: string, documents: OverviewDocument[], extra: Partial<OverviewSource> = {}): OverviewSource => ({
  node_id, title: node_id, parent_title: "공통", origin: { kind: "profile" }, applies_when: null, mode: "full", depth: 2, chars: 100, token_estimate: 25, status: "ok", documents, ...extra,
});
const profile = (agent_id: string, sources: OverviewSource[], extra: Partial<OverviewProfile> = {}): OverviewProfile => ({
  agent_id, display_name: `이름-${agent_id}`, source: "db", status: "ok", error: null, sources, ...extra,
});
const skills = ["a", "b", "c"].map(name => ({
  name, description: "", entry_node_id: `n-${name}`, entry_card_id: `c-${name}`, body_node_id: `b-${name}`, lint: null,
}));
const skillList = (prefix: string) => [doc(`${prefix}-root`, `${prefix}-rc`, 0), ...["a", "b", "c"].map(name => doc(`${prefix}-${name}`, `c-${name}`))];

const overview: ContextOverview = {
  node_id: "node-a", collected_at: null,
  profiles: [
    profile("p1", [source("shared", [doc("x", "x")]), source("cond", [doc("y", "y")], { applies_when: { card_role: ["assignee"] } }), source("own1", [doc("g1", "g1")]), source("skills1", skillList("s1"))]),
    profile("p2", [source("shared", [doc("x", "x")]), source("cond", [doc("y", "y")], { applies_when: { card_role: ["assignee"] } }), source("skills2", skillList("s2"))], { source: "yaml" }),
    profile("p3", [], { status: "error", error: "노드에 연결하지 못했습니다.", display_name: "아주 긴 이름을 가진 오류 프로필이 열 머리에서 말줄임이 되는지 본다" }),
  ],
};

let root: Root | undefined;
let host: HTMLDivElement | undefined;
async function flush() { await act(async () => { await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); await Promise.resolve(); }); }
function makeRequest(data: ContextOverview | number) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/skill-guides") return Response.json({ skills, catalogs: [], report: null });
    if (url.endsWith("/context-overview")) return typeof data === "number" ? new Response("{}", { status: data }) : Response.json(data);
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}
async function mount(request: typeof fetch, nodeId = "node-a") {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(ProfileOverviewMatrix, { nodeId, request })); });
  await flush(); await flush();
}
const rowLabels = () => Array.from(document.body.querySelectorAll("tbody th")).map(th => th.textContent);

beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = undefined; host = undefined; resetGuideSession();
});

describe("ProfileOverviewMatrix", () => {
  it("두 프로필이 함께 쓰는 소스는 한 줄씩, 한 프로필만 쓰는 소스는 두 줄로 모은다", async () => {
    await mount(makeRequest(overview));
    expect(rowLabels()).toEqual(["공통 / shared", "공통 / cond" + "card_role: assignee", "프로필마다 따로 둔 지침", "스킬 목록"]);
  });

  it("조건부 줄은 줄 이름 아래에 조건을 적고, 칸은 항상 · 조건부 · 없음을 값으로 갖는다", async () => {
    await mount(makeRequest(overview));
    const [shared, cond, own, skillsRow] = Array.from(document.body.querySelectorAll("tbody tr"));
    const labels = (tr: Element) => Array.from(tr.querySelectorAll("td")).map(td => td.querySelector("svg")?.getAttribute("aria-label") ?? "없음");
    expect(labels(shared!)).toEqual(["항상", "항상", "없음"]);
    expect(labels(cond!)).toEqual(["조건부: card_role: assignee", "조건부: card_role: assignee", "없음"]);
    expect(labels(own!)).toEqual(["항상", "없음", "없음"]);
    expect(labels(skillsRow!)).toEqual(["항상", "항상", "없음"]);
    expect(cond!.querySelector(".guides-matrix-condition")!.textContent).toBe("card_role: assignee");
  });

  it("열 머리는 이름 한 줄(눕힌 글)이고 전체 이름은 툴팁으로 둔다. 세로쓰기를 쓰지 않는다", async () => {
    await mount(makeRequest(overview));
    const heads = Array.from(document.body.querySelectorAll("thead th.guides-matrix-profile"));
    expect(heads).toHaveLength(3);
    expect(heads[0]!.querySelector("span")!.textContent).toBe("이름-p1");
    expect(heads[0]!.getAttribute("title")).toBe("이름-p1");
    expect(heads[2]!.getAttribute("title")).toContain("아주 긴 이름을 가진 오류 프로필");
    // 한국어가 세워진 채 한 글자씩 쌓이던 원인(writing-mode)을 쓰지 않고, 머리 높이에 상한을 둔다.
    const css = readFileSync(resolve(process.cwd(), "client/components/guides/guides.css"), "utf8");
    expect(css).not.toMatch(/writing-mode/);
    expect(css).toMatch(/rotate\(-90deg\)/);
    expect(css).toMatch(/--guides-head-height:/);
  });

  it("오류 프로필은 그 열만 표시하고 칸은 비우며 까닭은 툴팁이다. 표는 그대로 선다", async () => {
    await mount(makeRequest(overview));
    const errorHead = document.body.querySelector('thead th[data-error="true"]')!;
    expect(errorHead.getAttribute("title")).toContain("노드에 연결하지 못했습니다.");
    expect(errorHead.querySelector("svg")).not.toBeNull();
    const errorCells = Array.from(document.body.querySelectorAll('tbody td[data-error="true"]'));
    expect(errorCells.length).toBe(4);
    expect(errorCells.every(cell => cell.querySelector("svg") === null)).toBe(true);
    expect(document.body.querySelector("table")).not.toBeNull();
  });

  it("노드 설정 전용 프로필(yaml)의 첫 열에 구분선 표시를 단다", async () => {
    await mount(makeRequest(overview));
    expect(document.body.querySelector('thead th[data-first-node="true"]')!.getAttribute("title")).toBe("이름-p2");
  });

  it("프로필이 하나도 없으면 빈 상태 글이 선다", async () => {
    await mount(makeRequest({ node_id: "node-a", collected_at: null, profiles: [] }));
    expect(document.body.querySelector("table")).toBeNull();
    expect(document.body.textContent).toContain("프로필이 없습니다");
  });

  it("프로필은 있지만 실린 소스가 없으면 두 줄만 남고 칸은 모두 비어 있다", async () => {
    await mount(makeRequest({ node_id: "node-a", collected_at: null, profiles: [profile("p1", []), profile("p2", [])] }));
    expect(rowLabels()).toEqual(["프로필마다 따로 둔 지침", "스킬 목록"]);
    expect(document.body.querySelectorAll("tbody svg")).toHaveLength(0);
  });

  it("읽지 못하면 그 자리가 실패 안내로 바뀌고 다시 시도하면 표가 선다", async () => {
    let status: number | ContextOverview = 503;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/skill-guides") return Response.json({ skills, catalogs: [], report: null });
      return typeof status === "number" ? new Response("{}", { status }) : Response.json(status);
    }) as unknown as typeof fetch;
    await mount(request);
    expect(document.body.querySelector('[role="alert"]')!.textContent).toContain("프로필을 모으지 못했습니다");
    status = overview;
    const retry = Array.from(document.body.querySelectorAll("button")).find(item => item.textContent === "다시 시도")!;
    await act(async () => { retry.click(); });
    await flush(); await flush();
    expect(document.body.querySelector("table")).not.toBeNull();
  });

  it("읽는 동안에는 틀이 서고 스켈레톤이 보인다", async () => {
    await mount(vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch);
    const frame = document.body.querySelector('[data-testid="agent-context-overview"]')!;
    expect(frame.querySelector(".v3-run-skeleton")).not.toBeNull();
  });

  it("다른 실행 노드를 고르면 그 노드의 프로필로 칸이 바뀐다", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/skill-guides") return Response.json({ skills, catalogs: [], report: null });
      const other = url.includes("node-b");
      return Response.json({ node_id: other ? "node-b" : "node-a", collected_at: null, profiles: other ? [profile("n1", [source("shared", [doc("x", "x")])], { source: "yaml" })] : overview.profiles });
    }) as unknown as typeof fetch;
    await mount(request, "node-a");
    expect(document.body.querySelectorAll("thead th.guides-matrix-profile")).toHaveLength(3);
    await act(async () => { root!.render(createElement(ProfileOverviewMatrix, { nodeId: "node-b", request })); });
    await flush(); await flush();
    expect(document.body.querySelectorAll("thead th.guides-matrix-profile")).toHaveLength(1);
    expect(request).toHaveBeenCalledWith("/api/nodes/node-b/agents/context-overview", expect.anything());
  });
});
