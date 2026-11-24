/** @vitest-environment jsdom */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMatrix, computeSkillUsage, conditionText, formatChars, listText, loadedHow, profileCount, reportTime, requestVerify, resetGuideSession,
  severityRank, useContextOverview, useSkillGuides, worstFinding,
  type ContextOverview, type OverviewDocument, type OverviewProfile, type OverviewSource, type SkillGuide, type SkillGuides,
} from "./skill-guides";

const skill = (name: string, extra: Partial<SkillGuide> = {}): SkillGuide => ({
  name, description: `${name} 설명`, entry_node_id: `n-${name}`, entry_card_id: `c-${name}`, body_node_id: `b-${name}`, lint: null, ...extra,
});
const doc = (node_id: string, card_id: string, depth = 1, chars = 100, title = node_id): OverviewDocument => ({ node_id, card_id, title, depth, chars });
const source = (node_id: string, documents: OverviewDocument[], extra: Partial<OverviewSource> = {}): OverviewSource => ({
  node_id, title: node_id, parent_title: "공통", origin: { kind: "profile" }, applies_when: null, mode: "full", depth: 3, chars: 1000, token_estimate: 250, status: "ok", documents, ...extra,
});
const profile = (agent_id: string, sources: OverviewSource[], extra: Partial<OverviewProfile> = {}): OverviewProfile => ({
  agent_id, display_name: `프로필 ${agent_id}`, source: "db", status: "ok", error: null, sources, ...extra,
});
const overview = (profiles: OverviewProfile[]): ContextOverview => ({ node_id: "node-a", collected_at: null, profiles });

const skills = [skill("alpha"), skill("beta"), skill("gamma"), skill("delta")];
const byCard = new Map(skills.map(item => [item.entry_card_id, item]));

describe("loadedHow", () => {
  it("제목만 소스와 색인 뿌리 아래 문서는 제목만, 스킬 엔트리는 본문 노드가 같은 소스에 있으면 본문까지", () => {
    const nodes = new Set(["n1", "b-alpha"]);
    expect(loadedHow({ mode: "titles" }, doc("n1", "c-alpha"), byCard, nodes)).toBe("title");
    expect(loadedHow({ mode: "index" }, doc("n1", "c-alpha", 1), byCard, nodes)).toBe("title");
    expect(loadedHow({ mode: "index" }, doc("root", "x", 0, 50), byCard, nodes)).toBe("body");
    expect(loadedHow({ mode: "full" }, doc("n1", "c-alpha"), byCard, nodes)).toBe("body");
    expect(loadedHow({ mode: "full" }, doc("n2", "c-beta"), byCard, nodes)).toBe("entry");
    expect(loadedHow({ mode: undefined }, doc("n3", "x", 1, 0), byCard, nodes)).toBeNull();
  });
});

describe("computeSkillUsage", () => {
  const data = overview([
    profile("p1", [source("s1", [doc("r", "root", 0, 0), doc("e1", "c-alpha"), doc("b-alpha", "bc-alpha", 2), doc("e2", "c-beta")], { origin: { kind: "bundle", bundle_id: "공통", bundle_name: "공통 스킬" }, applies_when: { os: ["windows"] } })]),
    profile("p2", [source("s2", [doc("e3", "c-alpha")], { origin: { kind: "node_config" }, mode: "index" })]),
    profile("p3", [source("s3", [doc("e4", "c-alpha")])], { status: "error", error: "연결 실패" }),
  ]);
  const usage = computeSkillUsage(data, skills);
  it("스킬마다 프로필, 출처 말, 조건, 실린 방식을 계산하고 오류 프로필은 건너뛴다", () => {
    expect(usage.get("alpha")).toEqual([
      { profileId: "p1", profileName: "프로필 p1", origin: "공통 스킬", sourceTitle: "s1", sourceParent: "공통", appliesWhen: { os: ["windows"] }, how: "body" },
      { profileId: "p2", profileName: "프로필 p2", origin: "노드 설정", sourceTitle: "s2", sourceParent: "공통", appliesWhen: null, how: "title" },
    ]);
    expect(usage.get("beta")?.map(item => item.how)).toEqual(["entry"]);
    expect(usage.has("gamma")).toBe(false);
    expect(profileCount(usage.get("alpha"))).toBe(2);
    expect(profileCount(undefined)).toBe(0);
  });
  it("overview가 없으면 비어 있다", () => {
    expect(computeSkillUsage(null, skills).size).toBe(0);
  });
});

describe("buildMatrix", () => {
  const skillDocs = (prefix: string) => [doc(`${prefix}-root`, `${prefix}-rc`, 0, 0), ...["alpha", "beta", "gamma"].map(name => doc(`${prefix}-${name}`, `c-${name}`))];
  const data = overview([
    profile("p1", [source("common", [doc("c1", "x")]), source("cond", [doc("c2", "y")], { applies_when: { card_role: ["assignee"] } }), source("own-guide-1", [doc("g1", "z")]), source("own-skills-1", skillDocs("a"))]),
    profile("p2", [source("common", [doc("c1", "x")]), source("cond", [doc("c2", "y")]), source("cond", [doc("c2", "y")], { applies_when: { card_role: ["member"] } }), source("own-skills-2", skillDocs("b"))], { source: "yaml" }),
    profile("p3", [source("common", [doc("c1", "x")])], { status: "error", error: "x" }),
  ]);
  const matrix = buildMatrix(data, skills);
  it("두 프로필 이상이 쓰는 소스는 한 줄씩, 많이 쓰는 차례로 둔다", () => {
    expect(matrix.rows.map(row => row.node_id)).toEqual(["common", "cond"]);
    expect(Object.keys(matrix.rows[0]!.cells)).toEqual(["p1", "p2"]);
  });
  it("조건이 없는 칸이 조건부 칸을 이기고, 조건부는 조건 글을 갖는다", () => {
    expect(matrix.rows[1]!.cells).toEqual({ p1: { state: "conditional", condition: "card_role: assignee" }, p2: { state: "always" } });
  });
  it("한 프로필만 쓰는 소스는 따로 둔 지침과 스킬 목록 두 줄로 모은다", () => {
    expect(matrix.ownGuides).toEqual({ p1: { state: "always" } });
    expect(Object.keys(matrix.ownSkills).sort()).toEqual(["p1", "p2"]);
  });
  it("오류 프로필은 칸 없이 열만 남는다", () => {
    expect(matrix.profiles.map(item => item.agent_id)).toEqual(["p1", "p2", "p3"]);
    expect(Object.values(matrix.rows).every(row => !("p3" in row.cells))).toBe(true);
  });
  it("프로필이 없으면 줄도 없다", () => {
    const empty = buildMatrix(overview([]), skills);
    expect(empty).toMatchObject({ profiles: [], rows: [], ownGuides: {}, ownSkills: {} });
  });
});

describe("작은 계산", () => {
  it("진단은 가장 무거운 것과 그 수, 차례는 오류, 경고, 정보, 없음", () => {
    const f = (level: "error" | "warning" | "info") => ({ code: "X", level, message: "m" });
    expect(worstFinding([])).toBeNull();
    expect(worstFinding([f("warning"), f("error"), f("error")])).toEqual({ level: "error", count: 2 });
    expect([severityRank([f("error")]), severityRank([f("warning")]), severityRank([f("info")]), severityRank([])]).toEqual([0, 1, 2, 3]);
  });
  it("조건 글, 글자 수, 느슨한 값 펴기", () => {
    expect(conditionText({ backend: ["codex"], card_role: ["assignee", "member"] })).toBe("backend: codex · card_role: assignee, member");
    expect(conditionText(null)).toBe("");
    expect(formatChars(1234)).toBe("1,234자");
    expect(listText(["a", ["b"], { k: ["v", "w"] }, null])).toEqual(["a", "b", "k: v, w"]);
    expect(listText("축")).toEqual(["축"]);
    expect(listText(null)).toEqual([]);
  });
  it("보고 시각은 만든 때, 없으면 올린 때, 보고가 없으면 null", () => {
    expect(reportTime(null)).toBeNull();
    const base = { uploaded_by_session_id: null, verify_job_id: null, findings: [] };
    expect(reportTime({ ...base, generated_at: "2026-11-25T05:30:00.000Z", uploaded_at: null })).toBe("11월 25일 14:30");
    expect(reportTime({ ...base, generated_at: null, uploaded_at: "2026-11-25T06:00:00.000Z" })).toBe("11월 25일 15:00");
  });
});

describe("서버 꼴 읽기", () => {
  afterEach(() => { vi.unstubAllGlobals(); resetGuideSession(); });
  const mount = (component: () => null) => {
    const host = document.createElement("div");
    const root = createRoot(host);
    flushSync(() => root.render(createElement(component)));
    return () => flushSync(() => root.unmount());
  };

  it("lint와 report가 null이고 링크 종류가 null인 옛 보고도 그대로 읽는다", async () => {
    const body = {
      skills: [
        { name: "a", description: "d", entry_node_id: "e", entry_card_id: "ec", body_node_id: "bn", lint: null },
        { name: "b", description: "d", entry_node_id: "e2", entry_card_id: "ec2", body_node_id: "bn2", lint: { body_chars: 5, links: [{ kind: null, target: "a", target_kind: "skill" }], called_by: [], block_counts: {}, agent_count: 0, findings: [] } },
      ],
      catalogs: [{ name: "c", description: "d", node_id: "n", card_id: "cc", lint: null }],
      report: null,
    };
    const request = vi.fn(async () => Response.json(body));
    let seen: SkillGuides | null = null;
    const unmount = mount(() => { const { state } = useSkillGuides(request as unknown as typeof fetch); if (state.status === "ready") seen = state.data; return null; });
    await vi.waitFor(() => expect(seen).not.toBeNull());
    expect(request).toHaveBeenCalledWith("/api/skill-guides", expect.objectContaining({ credentials: "same-origin" }));
    expect(seen!.report).toBeNull();
    expect(seen!.skills[0]!.lint).toBeNull();
    expect(seen!.skills[1]!.lint!.links[0]!.kind).toBeNull();
    expect(seen!.catalogs[0]!.lint).toBeNull();
    unmount();
  });

  it("목록 요청이 실패하면 error 상태가 된다", async () => {
    const request = vi.fn(async () => new Response("{}", { status: 503 }));
    let status = "";
    const unmount = mount(() => { status = useSkillGuides(request as unknown as typeof fetch).state.status; return null; });
    await vi.waitFor(() => expect(status).toBe("error"));
    unmount();
  });

  it("다시 검증은 202면 시작, 409면 작업 없음, 그 밖은 실패", async () => {
    const answer = (status: number) => requestVerify((async () => new Response("{}", { status })) as typeof fetch);
    expect(await answer(202)).toEqual({ kind: "started" });
    expect(await answer(409)).toEqual({ kind: "none" });
    expect(await answer(500)).toEqual({ kind: "failed" });
    expect(await requestVerify((async () => { throw new Error("offline"); }) as typeof fetch)).toEqual({ kind: "failed" });
  });

  it("context-overview는 노드마다 한 번만 읽어 두고, 창을 닫으면(reset) 버린다", async () => {
    const request = vi.fn(async () => Response.json({ node_id: "node-a", collected_at: "2026-11-25T05:50:00Z", profiles: [] }));
    const states: string[] = [];
    const unmountFirst = mount(() => { states.push(useContextOverview("node-a", request as unknown as typeof fetch).state.status); return null; });
    await vi.waitFor(() => expect(states.at(-1)).toBe("ready"));
    unmountFirst();
    const unmountSecond = mount(() => { states.push(useContextOverview("node-a", request as unknown as typeof fetch).state.status); return null; });
    expect(request).toHaveBeenCalledTimes(1);
    unmountSecond();
    resetGuideSession();
    const unmountThird = mount(() => { states.push(useContextOverview("node-a", request as unknown as typeof fetch).state.status); return null; });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    unmountThird();
  });
});
