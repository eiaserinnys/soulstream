// 지침과 스킬 보기(설정 > 에이전트, 스킬과 카탈로그, 한눈에)의 견본 자료.
// 모든 이름, 글, 식별자는 지어낸 것이다. 운영의 모양(프로필 18개: 중앙 11, 노드 설정 7, 스킬 180, 카탈로그 27,
// 가장 긴 이름과 설명, 진단 섞임)만 갖췄고 실제 프로필이나 스킬 이름을 담지 않는다.
import type { CatalogGuide, ContextOverview, GuideFinding, GuideReport, OverviewDocument, OverviewProfile, OverviewSource, SkillGuide, SkillLink } from "../lib/skill-guides";

const uuid = (kind: number, index: number) => `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

const ROOTS = ["lantern", "quarry", "tidal", "ember", "willow", "cobalt", "juniper", "saffron", "basalt", "meadow", "harbor", "orchid"];
const TAILS = ["brief", "audit", "sync", "draft", "digest", "relay", "index", "verify", "archive", "triage", "compose", "summarize", "reconcile", "inspect", "publish"];
export const LONGEST_SKILL_NAME = "cobalt-reconcile-long-running-migration-checklist-for-staging-and-production-rollouts";
const DESCRIPTIONS = [
  "가상의 작업 기록을 모아 한 장으로 정리한다. 요청이 길어질 때 먼저 부른다.",
  "견본 문서의 변경 이력을 훑어 빠진 항목을 알려 준다.",
  "예시 저장소의 설정을 읽고 서로 어긋난 값을 표로 보인다. 쓰기 전에 읽기만 한다.",
  "지어낸 보고서 초안을 단락별로 다듬는다. 말투와 길이를 바꾸지 않는다.",
  "견본 일정표에서 겹치는 칸을 찾아 순서를 제안한다.",
  "가상의 알림 묶음을 종류별로 나누어 요약한다.",
];
export const LONGEST_DESCRIPTION = "이 설명은 일부러 길게 쓴 견본이다. 목록 줄에서는 한 줄로 줄어들고 상세 머리에서는 여러 줄로 이어지며, 좁은 폭에서도 가로 스크롤이 생기지 않고 말줄임이나 줄바꿈으로 처리되는지를 확인하기 위해 같은 뜻을 되풀이해서 늘려 쓴다. 가상의 작업 기록을 모아 한 장으로 정리하고, 변경 이력을 훑어 빠진 항목을 알리고, 설정이 어긋난 값을 표로 보인다.";

const SKILL_COUNT = 180;
const CATALOG_COUNT = 27;
const skillName = (index: number) => index === 6 ? LONGEST_SKILL_NAME : `${ROOTS[index % ROOTS.length]}-${TAILS[Math.floor(index / ROOTS.length) % TAILS.length]}`;
const catalogName = (index: number) => `${ROOTS[index % ROOTS.length]}-${["axis", "board", "chart"][Math.floor(index / ROOTS.length) % 3]}-catalog`;

const finding = (code: string, level: GuideFinding["level"], message: string): GuideFinding => ({ code, level, message });
const FINDING_POOL: GuideFinding[] = [
  finding("E007", "error", "링크 call 이름을 찾을 수 없음: ember-orphan-skill (줄 14)"),
  finding("E012", "error", "본문 노드가 엔트리 카드의 자식이 아님: 이름이 같은 카드가 둘 있다"),
  finding("W103", "warning", "겹친 절: 「캐릭터 코드」 절이 lantern-brief와 같은 제목으로 두 번 실린다"),
  finding("W106", "warning", "상대 경로로 적은 스크립트 위치가 노드마다 다르다. 환경 변수로 바꾸라"),
  finding("W104", "warning", "본문이 7,000자를 넘는다. 샤드로 나누는 것을 검토한다"),
  finding("I201", "info", "설명이 80자를 넘는다. 트리거 문장을 앞에 두면 발동이 빨라진다"),
];

function skillLinks(index: number): SkillLink[] {
  const count = index % 5;
  const links: SkillLink[] = [];
  for (let step = 0; step < count; step += 1) {
    const kinds = ["call", "include", "pick", "uses"] as const;
    if (step === 3) links.push({ kind: "uses", target: catalogName((index + step) % CATALOG_COUNT), target_kind: "catalog" });
    else links.push({ kind: index % 29 === 0 ? null : kinds[(index + step) % 3]!, target: skillName((index * 7 + step * 13 + 1) % SKILL_COUNT), target_kind: "skill" });
  }
  return links.filter(link => link.target !== skillName(index));
}

const links = Array.from({ length: SKILL_COUNT }, (_, index) => skillLinks(index));

export const guideSkills: SkillGuide[] = Array.from({ length: SKILL_COUNT }, (_, index) => {
  const name = skillName(index);
  const findings = index % 11 === 0 ? FINDING_POOL.slice(0, 1 + (index % 2)) : index % 5 === 0 ? FINDING_POOL.slice(2, 3 + (index % 3)) : index % 13 === 0 ? FINDING_POOL.slice(5) : [];
  return {
    name,
    description: index === 6 ? LONGEST_DESCRIPTION : DESCRIPTIONS[index % DESCRIPTIONS.length]!,
    entry_node_id: uuid(1, index), entry_card_id: uuid(2, index), body_node_id: uuid(3, index),
    lint: index % 17 === 0 ? null : {
      body_chars: 900 + ((index * 379) % 6400),
      links: links[index]!,
      called_by: links.flatMap((list, from) => list.some(link => link.target === name) ? [skillName(from)] : []).slice(0, 6),
      block_counts: { call: links[index]!.filter(link => link.kind === "call").length, include: 1, pick: 0 },
      agent_count: 1 + (index % 4),
      findings,
    },
  };
});

export const guideCatalogs: CatalogGuide[] = Array.from({ length: CATALOG_COUNT }, (_, index) => ({
  name: catalogName(index),
  description: index === 4 ? LONGEST_DESCRIPTION : `가상의 갈래 ${index + 1}번. ${DESCRIPTIONS[index % DESCRIPTIONS.length]}`,
  node_id: uuid(4, index), card_id: uuid(5, index),
  lint: index % 9 === 8 ? null : {
    axis: index % 4 === 3 ? ["작업 종류", "실행 환경", "대상 문서"] : ["작업 종류", "실행 환경"],
    composition: [`${skillName(index)} (기본)`, `${skillName(index + 40)}`, `${skillName(index + 80)} (조건부)`],
    used_by: guideSkills.filter((_, from) => links[from]!.some(link => link.target === catalogName(index))).map(skill => skill.name).slice(0, 8),
    findings: index % 7 === 0 ? FINDING_POOL.slice(2, 3) : [],
  },
}));

export const guideReport: GuideReport = {
  generated_at: "2026-11-25T05:30:00.000Z", uploaded_at: "2026-11-25T05:41:12.000Z",
  uploaded_by_session_id: "견본-세션", verify_job_id: "견본-검증-작업", findings: FINDING_POOL.slice(0, 2),
};

// 프로필 18개: 중앙 11(db) + 노드 설정 7(yaml). 한 칸은 오류 프로필이다.
const CENTRAL = ["한울", "보람", "새벽", "고운", "나래", "다솜", "마루", "바람", "아름", "여울", "온새미 — 열 머리에서 말줄임이 되는지 보려고 일부러 길게 지은 이름"];
const NODE_PROFILES: Record<string, string[]> = {
  "sample-node": ["누리", "도담", "라온", "미리내", "소담", "아라", "채움"],
  "sample-usage-node": ["가온", "나비", "하늬"],
};
export const OVERVIEW_ERROR_PROFILE = "아름";

const doc = (node: number, card: number, title: string, depth: number, chars: number): OverviewDocument => ({ node_id: uuid(6, node), card_id: uuid(7, card), title, depth, chars });
function docTree(seed: number, parent: string, count: number): OverviewDocument[] {
  const root = doc(seed * 100, seed * 100, parent, 0, 0);
  return [root, ...Array.from({ length: count }, (_, i) => doc(seed * 100 + i + 1, seed * 100 + i + 1, `규칙 ${String(i + 1).padStart(2, "0")}`, 1 + (i % 3 === 2 ? 1 : 0), 700 + ((seed * 131 + i * 977) % 5200)))];
}

/** 스킬 목록 소스의 문서: 엔트리 카드(깊이 1)와, 본문까지 싣는 소스는 본문 노드(깊이 2). */
function skillListDocs(seed: number, from: number, count: number, withBodies: boolean): OverviewDocument[] {
  const root = doc(seed * 100, seed * 100, "skills", 0, 0);
  const docs = [root];
  for (let index = from; index < from + count; index += 1) {
    const skill = guideSkills[index % SKILL_COUNT]!;
    docs.push({ node_id: skill.entry_node_id, card_id: skill.entry_card_id, title: skill.name, depth: 1, chars: 260 + ((index * 53) % 320) });
    if (withBodies) docs.push({ node_id: skill.body_node_id, card_id: uuid(8, index % SKILL_COUNT), title: `${skill.name} 본문`, depth: 2, chars: skill.lint?.body_chars ?? 2400 });
  }
  return docs;
}

const shared = (seed: number, title: string, parent: string, bundle: string, chars: number, when: OverviewSource["applies_when"], docs: OverviewDocument[], mode = "full"): OverviewSource => ({
  node_id: uuid(6, seed * 100), title, parent_title: parent, origin: { kind: "bundle", bundle_id: bundle, bundle_name: bundle },
  applies_when: when, mode, depth: 3, chars, token_estimate: Math.ceil(chars / 4), status: "ok", documents: docs,
});

function profileSources(index: number, nodeProfile: boolean, name: string): OverviewSource[] {
  const sources: OverviewSource[] = [
    shared(1, "rules", "공통", "공통 규칙", 18400, null, docTree(1, "rules", 9)),
    shared(2, "workflow", "공통", "공통 규칙", 9300, null, docTree(2, "workflow", 4)),
  ];
  if (!nodeProfile || index % 2 === 0) sources.push(shared(3, "skills", "공통", "공통 스킬", 41200, null, skillListDocs(3, 0, 24, true), "full"));
  if (index % 3 === 0) sources.push(shared(4, "windows-specific", "코딩", "윈도우 노드", 4100, { os: ["windows"] }, docTree(4, "windows-specific", 3)));
  if (index % 2 === 1) sources.push(shared(5, "card-rules", "공통", "카드 작업", 7300, { card_role: ["assignee"] }, docTree(5, "card-rules", 5)));
  if (index % 4 === 2) sources.push(shared(6, "slack", "공통", "슬랙 대화", 2600, { source: ["slack"] }, docTree(6, "slack", 2)));
  const own: OverviewSource[] = [
    { ...shared(20 + index, "rules", name.slice(0, 12), "", 5200 + index * 311, null, docTree(20 + index, "rules", 3 + (index % 4))), origin: nodeProfile ? { kind: "node_config" } : { kind: "profile" } },
    { ...shared(40 + index, "skills", name.slice(0, 12), "", 12800 + index * 97, null, skillListDocs(40 + index, 30 + index * 5, 6 + (index % 5), index % 3 !== 1), index % 3 === 2 ? "index" : "full"), origin: nodeProfile ? { kind: "node_config" } : { kind: "profile" } },
  ];
  return [...sources, ...own];
}

export function buildOverview(nodeId: string, options: { errorProfile?: boolean; empty?: boolean } = {}): ContextOverview {
  if (options.empty) return { node_id: nodeId, collected_at: "2026-11-25T05:50:00.000Z", profiles: [] };
  const nodeNames = NODE_PROFILES[nodeId] ?? NODE_PROFILES["sample-node"]!;
  const profiles: OverviewProfile[] = [
    ...CENTRAL.map((name, index) => ({ name, index, node: false })),
    ...nodeNames.map((name, index) => ({ name, index: 11 + index, node: true })),
  ].map(({ name, index, node }) => {
    const failed = options.errorProfile !== false && name === OVERVIEW_ERROR_PROFILE;
    return {
      agent_id: `${node ? "node" : "central"}-${index}`, display_name: name, source: node ? "yaml" : "db",
      status: failed ? "error" as const : "ok" as const, error: failed ? "노드에 연결하지 못했습니다." : null,
      sources: failed ? [] : profileSources(index, node, name),
    };
  });
  return { node_id: nodeId, collected_at: "2026-11-25T05:50:00.000Z", profiles };
}
