// 지침과 스킬 보기의 자료층. 서버 응답 꼴(snake_case) 그대로 읽고, 쓰이는 곳과 실린 방식은 화면이 계산한다.
//  - GET /api/skill-guides: 스킬과 카탈로그 목록, 린트 보고(lint, report)
//  - GET /api/nodes/:node_id/agents/context-overview: 노드의 프로필마다 실린 소스와 문서
import type { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export type LinkKind = "call" | "include" | "pick" | "uses";
export type FindingLevel = "error" | "warning" | "info";
/** 문서가 실린 방식. body는 본문까지, entry는 이름과 설명만, title은 제목만. */
export type LoadedHow = "body" | "entry" | "title";

/** 옛 보고는 종류 없이 대상만 싣는다(kind가 null). */
export interface SkillLink { kind: LinkKind | null; target: string; target_kind: "skill" | "catalog" | null }
export interface GuideFinding { code: string; level: FindingLevel; message: string }
export interface SkillLint {
  body_chars: number;
  links: SkillLink[];
  called_by: string[];
  block_counts: Record<string, number>;
  agent_count: number;
  findings: GuideFinding[];
}
export interface SkillGuide {
  name: string;
  description: string;
  /** 엔트리 카드를 못 찾은 스킬은 둘 다 null이다. */
  entry_node_id: string | null;
  entry_card_id: string | null;
  body_node_id: string;
  /** 보고에 없으면 null. */
  lint: SkillLint | null;
}
export interface CatalogLint {
  axis: string | string[] | null;
  composition: unknown;
  used_by: string[];
  findings: GuideFinding[];
}
export interface CatalogGuide {
  name: string;
  description: string;
  node_id: string | null;
  card_id: string | null;
  lint: CatalogLint | null;
}
export interface GuideReport {
  generated_at: string | null;
  uploaded_at: string | null;
  uploaded_by_session_id: string | null;
  /** 있을 때만 「다시 검증」이 보인다. */
  verify_job_id: string | null;
  /** 읽은 뒤의 꼴. 서버는 보고 원본 레코드를 그대로 준다(`normalizeFinding`). */
  findings: GuideFinding[];
}
export interface SkillGuides {
  skills: SkillGuide[];
  catalogs: CatalogGuide[];
  report: GuideReport | null;
}

export type GuidesState =
  | { status: "loading" }
  | { status: "ready"; data: SkillGuides }
  | { status: "error" };

const guidesPath = "/api/skill-guides";

const LEVELS: readonly FindingLevel[] = ["error", "warning", "info"];

/**
 * 보고 원본 레코드를 진단 하나로 읽는다. level이 없거나 모르는 값이면 서버(levelOf)처럼 code 첫 글자로 정한다:
 * E는 error, I는 info, 나머지는 warning. message가 없으면 빈 글.
 */
export function normalizeFinding(raw: unknown): GuideFinding | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.code !== "string") return null;
  const level = LEVELS.find(item => item === record.level) ?? (record.code.startsWith("E") ? "error" : record.code.startsWith("I") ? "info" : "warning");
  return { code: record.code, level, message: typeof record.message === "string" ? record.message : "" };
}

const normalizeFindings = (raw: unknown): GuideFinding[] => Array.isArray(raw) ? raw.flatMap(item => normalizeFinding(item) ?? []) : [];

async function fetchGuides(request: typeof fetch, signal?: AbortSignal): Promise<SkillGuides> {
  const response = await request(guidesPath, { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`skill-guides ${response.status}`);
  const body = await response.json() as Partial<SkillGuides>;
  return {
    skills: body.skills ?? [],
    catalogs: body.catalogs ?? [],
    report: body.report ? { ...body.report, findings: normalizeFindings(body.report.findings) } : null,
  };
}

export function useSkillGuides(request: typeof fetch = fetch): {
  state: GuidesState;
  /** 로딩 표시로 돌아가 다시 읽는다. */
  reload(): void;
  /** 화면은 그대로 두고 조용히 다시 읽는다. 실패하면 null. */
  refresh(): Promise<SkillGuides | null>;
} {
  const [state, setState] = useState<GuidesState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const data = await fetchGuides(request, controller.signal);
        setState({ status: "ready", data });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error" });
      }
    })();
    return () => controller.abort();
  }, [request, attempt]);
  const reload = useCallback(() => { setState({ status: "loading" }); setAttempt(value => value + 1); }, []);
  const refresh = useCallback(async () => {
    try {
      const data = await fetchGuides(request);
      if (alive.current) setState({ status: "ready", data });
      return data;
    } catch {
      return null;
    }
  }, [request]);
  return { state, reload, refresh };
}

export type VerifyResult = { kind: "started" } | { kind: "none" } | { kind: "failed" };

/** 다시 검증: 202면 시작, 409(no_verify_job)면 보고를 만든 작업이 없다는 뜻이다. */
export async function requestVerify(request: typeof fetch): Promise<VerifyResult> {
  try {
    const response = await request(`${guidesPath}/verify`, { method: "POST", credentials: "same-origin" });
    if (response.status === 202) return { kind: "started" };
    if (response.status === 409) return { kind: "none" };
    return { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

export async function fetchSkillBody(request: typeof fetch, name: string, signal?: AbortSignal): Promise<string> {
  const response = await request(`${guidesPath}/${encodeURIComponent(name)}/body`, { credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`skill body ${response.status}`);
  return (await response.json() as { markdown: string }).markdown;
}

// ---------------------------------------------------------------------------------------------
// context-overview: 노드의 프로필마다 실린 소스. 노드마다 한 번 읽어 설정 창이 열린 동안 두고, 창을 닫으면 버린다.

export type SourceOrigin = { kind: "bundle"; bundle_id: string; bundle_name: string } | { kind: "profile" } | { kind: "node_config" };
export interface OverviewDocument { node_id: string; card_id: string | null; title: string; depth: number; chars: number }
export interface OverviewSource {
  node_id: string;
  title: string | null;
  parent_title: string | null;
  origin: SourceOrigin;
  applies_when: Record<string, string[]> | null;
  mode: string;
  depth: number;
  chars: number;
  token_estimate: number;
  status: string;
  documents: OverviewDocument[];
}
export interface OverviewProfile {
  agent_id: string;
  /** 이름이 없는 프로필은 null. 화면은 `profileLabel`로 agent_id를 쓴다. */
  display_name: string | null;
  /** 노드 설정 전용 프로필은 "yaml", 중앙 프로필은 "db". */
  source: string;
  status: "ok" | "error";
  error: string | null;
  sources: OverviewSource[];
}
export interface ContextOverview { node_id: string; collected_at: string | null; profiles: OverviewProfile[] }

export type OverviewState =
  | { status: "loading" }
  | { status: "ready"; data: ContextOverview }
  | { status: "error" };

interface OverviewEntry { state: OverviewState; generation: number }
const overviewEntries = new Map<string, OverviewEntry>();
const listeners = new Set<() => void>();
const LOADING: OverviewState = { status: "loading" };
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

async function loadOverview(nodeId: string, request: typeof fetch): Promise<void> {
  const generation = (overviewEntries.get(nodeId)?.generation ?? 0) + 1;
  overviewEntries.set(nodeId, { state: LOADING, generation });
  emit();
  let state: OverviewState;
  try {
    const response = await request(`/api/nodes/${encodeURIComponent(nodeId)}/agents/context-overview`, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`context-overview ${response.status}`);
    const body = await response.json() as Partial<ContextOverview>;
    state = { status: "ready", data: { node_id: body.node_id ?? nodeId, collected_at: body.collected_at ?? null, profiles: body.profiles ?? [] } };
  } catch {
    state = { status: "error" };
  }
  // 창을 닫아 버려졌거나 더 새 요청이 있으면 이 응답은 버린다.
  if (overviewEntries.get(nodeId)?.generation !== generation) return;
  overviewEntries.set(nodeId, { state, generation });
  emit();
}

/** 설정 창을 닫을 때 부른다. 노드마다 둔 overview와 고른 실행 노드를 버린다. */
export function resetGuideSession(): void {
  overviewEntries.clear();
  execNode = "";
  emit();
}

export function useContextOverview(nodeId: string, request: typeof fetch = fetch): { state: OverviewState; reload(): void } {
  const state = useSyncExternalStore(subscribe, () => overviewEntries.get(nodeId)?.state ?? LOADING);
  useEffect(() => {
    if (nodeId && !overviewEntries.has(nodeId)) void loadOverview(nodeId, request);
  }, [nodeId, request]);
  const reload = useCallback(() => { if (nodeId) void loadOverview(nodeId, request); }, [nodeId, request]);
  return { state, reload };
}

// 에이전트 탭이 고른 실행 노드. 스킬 탭이 같은 노드로 쓰이는 곳을 보인다.
let execNode = "";
export function useExecNode(): [string, (nodeId: string) => void] {
  const value = useSyncExternalStore(subscribe, () => execNode);
  const set = useCallback((nodeId: string) => { if (nodeId !== execNode) { execNode = nodeId; emit(); } }, []);
  return [value, set];
}

// ---------------------------------------------------------------------------------------------
// 계산: 실린 방식, 쓰이는 곳, 한눈에 표

export const profileLabel = (profile: { agent_id: string; display_name: string | null }): string => profile.display_name || profile.agent_id;

type Translate = ReturnType<typeof useTranslation>["t"];

const originLabel = (origin: SourceOrigin, t: Translate): string =>
  origin.kind === "bundle" ? origin.bundle_name : origin.kind === "profile" ? t("agents.profile.label") : t("agents.profile.nodeSettings");

/** 조건 한 줄: `backend: codex · card_role: assignee`. 조건이 없으면 빈 글. */
export function conditionText(appliesWhen: Record<string, string[]> | null | undefined): string {
  if (!appliesWhen) return "";
  return Object.entries(appliesWhen)
    .map(([field, values]) => values.length > 0 ? `${field}: ${values.join(", ")}` : "")
    .filter(Boolean)
    .join(" · ");
}

/** 엔트리 카드가 없는 스킬은 문서와 이을 수 없어 건너뛴다. */
export function skillsByEntryCard(skills: readonly SkillGuide[]): Map<string, SkillGuide> {
  const byCard = new Map<string, SkillGuide>();
  for (const skill of skills) if (skill.entry_card_id) byCard.set(skill.entry_card_id, skill);
  return byCard;
}

export const skillForCard = (byCard: ReadonlyMap<string, SkillGuide>, cardId: string | null): SkillGuide | undefined => cardId ? byCard.get(cardId) : undefined;

/**
 * 문서가 소스에 실린 방식. 구조만 잡는 빈 문서는 null이다.
 * 제목만(titles) 소스, 색인(index)의 뿌리 아래 문서는 제목만. 스킬 엔트리 카드는 같은 소스에 본문 노드까지 있으면 본문까지, 없으면 이름과 설명만.
 */
export function loadedHow(
  source: { mode?: string },
  document: { node_id: string; card_id: string | null; depth: number; chars: number },
  skillsByCard: ReadonlyMap<string, SkillGuide>,
  nodeIdsInSource: ReadonlySet<string>,
): LoadedHow | null {
  if (source.mode === "titles" || (source.mode === "index" && document.depth > 0)) return "title";
  const skill = skillForCard(skillsByCard, document.card_id);
  if (skill) return nodeIdsInSource.has(skill.body_node_id) ? "body" : "entry";
  return document.chars > 0 ? "body" : null;
}

export interface SkillUsage {
  profileId: string;
  profileName: string;
  /** 번들 이름, 「프로필」, 「노드 설정」. */
  origin: string;
  sourceTitle: string | null;
  sourceParent: string | null;
  appliesWhen: Record<string, string[]> | null;
  how: LoadedHow;
}

/** 스킬 이름마다 어느 프로필의 어느 소스에 어떻게 실리는지. 오류 프로필은 건너뛴다. */
export function computeSkillUsage(overview: ContextOverview | null, skills: readonly SkillGuide[], t: Translate): Map<string, SkillUsage[]> {
  const usage = new Map<string, SkillUsage[]>();
  if (!overview) return usage;
  const byCard = skillsByEntryCard(skills);
  for (const profile of overview.profiles) {
    if (profile.status !== "ok") continue;
    for (const source of profile.sources) {
      const nodeIds = new Set(source.documents.map(document => document.node_id));
      for (const document of source.documents) {
        const skill = skillForCard(byCard, document.card_id);
        const how = skill ? loadedHow(source, document, byCard, nodeIds) : null;
        if (!skill || !how) continue;
        const list = usage.get(skill.name) ?? [];
        const origin = originLabel(source.origin, t);
        if (!list.some(item => item.profileId === profile.agent_id && item.origin === origin && item.sourceTitle === source.title && item.how === how)) {
          list.push({ profileId: profile.agent_id, profileName: profileLabel(profile), origin, sourceTitle: source.title, sourceParent: source.parent_title, appliesWhen: source.applies_when, how });
        }
        usage.set(skill.name, list);
      }
    }
  }
  return usage;
}

export const profileCount = (usages: readonly SkillUsage[] | undefined): number => new Set((usages ?? []).map(usage => usage.profileId)).size;

export type MatrixCell = { state: "always" } | { state: "conditional"; condition: string };
export interface MatrixRow { node_id: string; title: string | null; parent: string | null; cells: Record<string, MatrixCell> }
export interface ProfileMatrix {
  profiles: OverviewProfile[];
  /** 두 프로필 이상이 함께 쓰는 소스. 많이 쓰는 차례. */
  rows: MatrixRow[];
  /** 한 프로필만 쓰는 소스는 프로필마다 한 칸으로 모은다. */
  ownGuides: Record<string, MatrixCell>;
  ownSkills: Record<string, MatrixCell>;
}

/** 스킬 엔트리 카드가 이만큼 이상 든 소스는 스킬 목록이다. */
const SKILL_LIST_MIN_ENTRIES = 3;

function mergeCell(current: MatrixCell | undefined, next: MatrixCell): MatrixCell {
  return !current || (current.state === "conditional" && next.state === "always") ? next : current;
}

export function buildMatrix(overview: ContextOverview, skills: readonly SkillGuide[]): ProfileMatrix {
  const byCard = skillsByEntryCard(skills);
  const rows = new Map<string, MatrixRow & { skillEntries: number }>();
  for (const profile of overview.profiles) {
    if (profile.status !== "ok") continue;
    for (const source of profile.sources) {
      let row = rows.get(source.node_id);
      if (!row) {
        row = { node_id: source.node_id, title: source.title, parent: source.parent_title, cells: {}, skillEntries: source.documents.filter(document => skillForCard(byCard, document.card_id)).length };
        rows.set(source.node_id, row);
      }
      const condition = conditionText(source.applies_when);
      row.cells[profile.agent_id] = mergeCell(row.cells[profile.agent_id], condition ? { state: "conditional", condition } : { state: "always" });
    }
  }
  const shared = [...rows.values()].filter(row => Object.keys(row.cells).length >= 2)
    .sort((left, right) => Object.keys(right.cells).length - Object.keys(left.cells).length);
  const ownGuides: Record<string, MatrixCell> = {};
  const ownSkills: Record<string, MatrixCell> = {};
  for (const row of rows.values()) {
    if (Object.keys(row.cells).length >= 2) continue;
    const target = row.skillEntries >= SKILL_LIST_MIN_ENTRIES ? ownSkills : ownGuides;
    for (const [profileId, cell] of Object.entries(row.cells)) target[profileId] = mergeCell(target[profileId], cell);
  }
  return { profiles: overview.profiles, rows: shared.map(({ skillEntries: _unused, ...row }) => row), ownGuides, ownSkills };
}

// ---------------------------------------------------------------------------------------------
// 진단과 보고 시각

const LEVEL_ORDER: Record<FindingLevel, number> = { error: 0, warning: 1, info: 2 };

/** 가장 무거운 진단 하나와 그 수. 진단이 없으면 null. */
export function worstFinding(findings: readonly GuideFinding[]): { level: FindingLevel; count: number } | null {
  if (findings.length === 0) return null;
  const level = findings.map(finding => finding.level).sort((left, right) => LEVEL_ORDER[left] - LEVEL_ORDER[right])[0]!;
  return { level, count: findings.filter(finding => finding.level === level).length };
}

/** 작을수록 무겁다. 진단이 없으면 3. */
export function severityRank(findings: readonly GuideFinding[]): number {
  const worst = worstFinding(findings);
  return worst ? LEVEL_ORDER[worst.level] : 3;
}

/** 목록의 진단: 보고에 없으면(lint가 null) 빈 목록. */
export const skillFindings = (skill: SkillGuide): readonly GuideFinding[] => skill.lint?.findings ?? [];
export const catalogFindings = (catalog: CatalogGuide): readonly GuideFinding[] => catalog.lint?.findings ?? [];

const REPORT_TIME_OPTIONS = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Seoul" } satisfies Intl.DateTimeFormatOptions;

function formatReportTime(iso: string | null | undefined, language: string | undefined): string | null {
  if (!iso) return null;
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? null : new Intl.DateTimeFormat(language, REPORT_TIME_OPTIONS).format(time);
}

/** 보고 시각. 만든 때가 없으면 올린 때를 쓴다. */
export const reportTime = (report: GuideReport | null, language: string | undefined): string | null => formatReportTime(report?.generated_at ?? report?.uploaded_at, language);

/** 글자 수는 목록의 모든 수에서 이 꼴 하나로 적는다. */
export const formatChars = (chars: number, t: Translate, language: string | undefined): string => t("agents.charCount", { chars: chars.toLocaleString(language) });

/** 카탈로그 lint의 axis와 composition처럼 꼴이 느슨한 값을 글 목록으로 편다. */
export function listText(value: unknown): string[] {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value.flatMap(listText);
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const text = listText(item).join(", ");
    return text ? `${key}: ${text}` : key;
  });
  return [String(value)];
}
