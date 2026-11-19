import type { CatalogFolder, MarkdownDocument } from "@seosoyoung/soul-ui";
import type { CardColor, CardRow } from "@seosoyoung/soul-ui/cards/card-types";

export type DocKind = "question" | "task" | "review";
export type EvidenceId = "chips" | "architecture" | "stages" | "slide-before" | "slide-after" | "tree";

export interface EvidenceSpec {
  id: EvidenceId;
  caption: string;
  note: string;
}

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  time: string;
}

export interface CheckItem {
  id: number;
  title: string;
  result: string;
  caveat?: string;
}

export interface QuestionOption {
  label: string;
  description: string;
  recommended?: boolean;
}

/** 화면에 보이는 담당 표시. 내부 세션 식별자는 글에 쓰지 않는다. */
export interface AgentAssignee {
  name: string;
  role: string;
  /** 사람이 읽는 세션 이름. 예: "PAS 대화", "구현 세션". */
  session: string;
  agentId: "seosoyoung" | "roselin" | "keke" | "selaphiel";
}

export interface PendingDoc {
  id: string;
  number: number;
  kind: DocKind;
  kindLabel: string;
  subLabel?: string;
  folder: string;
  folderId: string;
  age: string;
  title: string;
  request: string;
  background?: string;
  options?: QuestionOption[];
  steps?: { title: string; detail: string }[];
  checks?: CheckItem[];
  unverified?: string;
  evidence: EvidenceSpec[];
  /** 참고 서재로 갈무리할 때 카드에 남길 실제 요약. */
  referenceSummary: string;
  document?: { id: string; title: string; path: string };
  assignee: AgentAssignee;
  messages: SessionMessage[];
  scheduledUntil?: string;
}

export interface ScenarioCard {
  id: string;
  number: number;
  title: string;
  folder: string;
  folderId: string;
  status: CardRow["status"];
  color: CardColor;
  activity: string;
  activityKind: "instruction" | "report";
  assignee: AgentAssignee;
  createdAt: string;
  reference?: boolean;
}

export const FOLDERS: CatalogFolder[] = [
  { id: "folder-soulstream", name: "✨ 소울스트림", parentFolderId: null, sortOrder: 0, status: "open", version: 1, archived: false },
  { id: "folder-pages", name: "🌐 Pages", parentFolderId: null, sortOrder: 1, status: "open", version: 1, archived: false },
  { id: "folder-kaleidoscope", name: "🔮 kaleidoscope", parentFolderId: null, sortOrder: 2, status: "open", version: 1, archived: false },
  { id: "folder-atom", name: "💡 atom", parentFolderId: null, sortOrder: 3, status: "open", version: 1, archived: false },
  { id: "folder-seosoyoung", name: "🪞 서소영", parentFolderId: null, sortOrder: 4, status: "open", version: 1, archived: false },
];

export function folderName(folderId: string): string {
  return FOLDERS.find(folder => folder.id === folderId)?.name ?? FOLDERS[0]!.name;
}

export function portraitUrl(agentId: string): string {
  return `/api/nodes/eiaserinnys/agents/${encodeURIComponent(agentId)}/portrait`;
}

const createdAt = (day: number) => `2026-11-${String(day).padStart(2, "0")}T09:00:00.000Z`;

export const DOC_1387_ID = "doc-1387";

export const DOC_1387: MarkdownDocument = {
  id: DOC_1387_ID,
  title: "턴 안 상호작용 설계안",
  version: 1,
  createdAt: "2026-11-15T05:10:00.000Z",
  updatedAt: "2026-11-18T09:34:00.000Z",
  body: `# 턴 안 상호작용 설계안

## 문제

지금 세션은 턴이 끝날 때까지 입력을 받지 않습니다. 턴이 길어지면 디렉터는 기다리는 동안 방향을 바꿀 수 없고, 잘못된 실행을 멈추려면 턴이 끝난 뒤에 다시 지시해야 합니다.

## 후보 비교

| 후보 | 변경 범위 | 위험 | 추가 요금 |
|---|---|---|---|
| 입력 큐 삽입 | 작음 | 낮음 | 0달러 |
| 실행 중단 | 중간 | 중간 | 0달러 |
| 재개 지점 저장 | 큼 | 높음 | 0달러 |

세 후보 모두 기존 MCP 호출을 막지 않습니다. 차단 MCP는 0건이고, 추가 요금도 0달러입니다.

## 3단계 도입

1. 입력 큐 삽입: 턴이 도는 동안 들어온 입력을 큐에 쌓고, 다음 턴 시작 전에 꺼냅니다.
2. 실행 중단: 실행 중인 도구 호출을 안전하게 멈추고 사용자에게 확인을 받습니다.
3. 재개 지점 저장: 중단 지점의 상태를 저장해 다른 노드에서도 이어 갈 수 있게 합니다.

## 검증 계획

1단계는 두 세션에서 입력 큐 잠금이 풀리는지 확인했습니다. 2단계와 3단계는 여러 노드가 섞인 경우를 아직 확인하지 못했습니다. 먼저 1단계를 배포하고, 입력 큐가 비워지는 시간을 일주일 동안 잽니다.`,
};

export const PENDING_DOCS: PendingDoc[] = [
  {
    id: "1680",
    number: 1680,
    kind: "question",
    kindLabel: "질문",
    folder: folderName("folder-soulstream"),
    folderId: "folder-soulstream",
    age: "15분 전",
    title: "완료 목록 기간 칩의 기본 선택 범위 결정",
    request: "완료 목록을 열 때 기간 칩이 무엇을 기본으로 골라야 하는지 정해 주세요. 지금은 매번 직접 고르게 되어 있어 확인이 번거롭습니다.",
    background: "완료 칩은 최근 7일, 오늘만, 전체 표시 세 가지입니다. 기본값이 없으면 화면을 열 때마다 이전 선택이 그대로 남아 사람마다 다른 목록을 보게 됩니다.",
    options: [
      { label: "최근 7일", description: "지난주에 끝난 일을 이어 보기 좋습니다. 대부분의 확인은 이 범위에서 끝납니다.", recommended: true },
      { label: "오늘만", description: "오늘 끝난 일만 봅니다. 매일 아침 확인하는 습관에는 맞지만 지난 일을 놓치기 쉽습니다." },
      { label: "전체 표시", description: "가장 넓게 보지만 목록이 길어져 첫 화면에서 스크롤이 생깁니다." },
    ],
    evidence: [
      { id: "chips", caption: "완료 칩 비교", note: "최근 7일 18건, 전체 412건, 최근 7일 선택 62%" },
    ],
    referenceSummary: "기간 칩 기본값을 최근 7일로 두고, 오늘만과 전체 표시는 그대로 두는 안.",
    assignee: { name: "서소영", role: "PAS", session: "PAS 대화", agentId: "seosoyoung" },
    messages: [
      { role: "assistant", text: "완료 목록 기간 칩의 기본값을 정하려고 합니다. 최근 7일, 오늘만, 전체 표시 중 어느 쪽이 좋을까요?", time: "오전 8:41" },
      { role: "user", text: "기본값이 없어서 매번 고르는 게 번거로웠어. 최근 7일이면 충분할 것 같아.", time: "오전 8:44" },
      { role: "assistant", text: "최근 7일을 기본으로 두고, 칩을 누르면 오늘만과 전체 표시로 바꿀 수 있게 하겠습니다.", time: "오전 8:45" },
    ],
  },
  {
    id: "1512",
    number: 1512,
    kind: "task",
    kindLabel: "부탁",
    folder: folderName("folder-kaleidoscope"),
    folderId: "folder-kaleidoscope",
    age: "40분 전",
    title: "집 PC kaleidoscope 앱스토어에서 사용량 앱 수동 업데이트 확인",
    request: "집 PC의 kaleidoscope 앱스토어에서 사용량 앱을 수동으로 업데이트하고, 알림이 실제로 오는지 확인해 주세요.",
    steps: [
      { title: "앱스토어 열기", detail: "집 PC에서 kaleidoscope 앱스토어를 열고 사용량 앱 항목을 찾습니다." },
      { title: "수동 업데이트", detail: "업데이트 단추를 눌러 최신 판으로 올립니다." },
      { title: "알림 확인", detail: "아침 예약 알림이 도착하는지 10분 안에 확인합니다." },
    ],
    evidence: [
      { id: "tree", caption: "업데이트 전후 판 번호", note: "앱스토어 사용량 앱 항목" },
    ],
    referenceSummary: "앱스토어 수동 업데이트 절차와 아침 알림 확인 결과.",
    assignee: { name: "로젤린", role: "코딩 실행", session: "구현 세션", agentId: "roselin" },
    messages: [
      { role: "user", text: "집 PC 앱스토어에서 사용량 앱을 수동으로 올려 줄 수 있어?", time: "오전 7:58" },
      { role: "assistant", text: "앱스토어를 열어 사용량 앱 항목을 확인하고, 업데이트 뒤 아침 알림까지 보겠습니다.", time: "오전 8:02" },
    ],
  },
  {
    id: "1387",
    number: 1387,
    kind: "review",
    kindLabel: "검수 대기",
    subLabel: "설계서",
    folder: folderName("folder-soulstream"),
    folderId: "folder-soulstream",
    age: "4일째 대기",
    title: "턴 안 상호작용 구현 가능성과 3단계 도입 설계안",
    request: "턴이 끝나기 전에 사용자가 개입할 수 있는지, 가능하다면 어떤 순서로 도입할지 설계해 주세요.",
    checks: [
      { id: 1, title: "현재 턴 처리 경로 조사", result: "세션 스트림과 실행 큐가 턴 단위로 잠겨 있어 중간 개입 지점이 없습니다." },
      { id: 2, title: "개입 지점 후보 비교", result: "입력 큐 삽입과 실행 중단 두 후보를 비교했고, 입력 큐 삽입이 변경 범위가 작습니다." },
      { id: 3, title: "3단계 도입 순서 정리", result: "1단계 입력 큐, 2단계 실행 중단, 3단계 재개 지점 저장 순서로 정리했습니다." },
    ],
    unverified: "실행 중 중단 뒤 재개는 실제 세션 두 건에서만 확인했습니다. 여러 노드가 섞인 경우는 확인하지 못했습니다.",
    evidence: [
      { id: "architecture", caption: "턴 처리 경로", note: "차단 MCP 0건, 추가 요금 0달러, 입력 큐 삽입 지점" },
      { id: "stages", caption: "3단계 도입 순서", note: "변경 범위와 검증 순서" },
    ],
    referenceSummary: "입력 큐 삽입을 1단계로 두는 3단계 도입 설계와 미확인 범위.",
    document: { id: DOC_1387_ID, title: "턴 안 상호작용 설계안", path: "pages.eiaserinnys.me/d/turn-interaction-design" },
    assignee: { name: "로젤린", role: "설계 조사", session: "설계 세션", agentId: "roselin" },
    messages: [
      { role: "user", text: "턴이 끝나기 전에 개입할 수 있는지 조사해 줘. 가능하면 단계도 나눠서.", time: "11월 15일 오후 2:10" },
      { role: "assistant", text: "입력 큐 삽입이 가장 작은 변경입니다. 1단계 입력 큐, 2단계 실행 중단, 3단계 재개 지점 저장으로 정리했습니다.", time: "11월 18일 오후 6:32" },
      { role: "assistant", text: "여러 노드가 섞인 재개는 아직 확인하지 못했습니다. 이 범위를 미확인으로 남겼습니다.", time: "11월 18일 오후 6:34" },
    ],
  },
  {
    id: "1408",
    number: 1408,
    kind: "review",
    kindLabel: "검수 대기",
    subLabel: "구현",
    folder: folderName("folder-pages"),
    folderId: "folder-pages",
    age: "1일 전",
    title: "슬라이드 편집 화면 장 유형과 순서 변경 및 줄간격 보정",
    request: "슬라이드 편집 화면에서 장 유형을 바꾸고 순서를 옮길 수 있게 해 주세요. 줄간격이 좁아 보이는 문제도 함께 고쳐 주세요.",
    checks: [
      { id: 1, title: "장 유형 전환", result: "제목, 본문, 이미지 세 유형을 서로 바꿀 수 있습니다." },
      { id: 2, title: "순서 변경", result: "끌어 옮기기와 위아래 단추 모두 동작합니다." },
      { id: 3, title: "줄간격 보정", result: "본문 줄간격을 1.32에서 1.55로 올렸습니다." },
    ],
    unverified: "인쇄 미리보기와 긴 슬라이드 20장 이상에서의 성능은 확인하지 못했습니다.",
    evidence: [
      { id: "slide-before", caption: "보정 전", note: "줄간격 1.32, 순서 단추 없음" },
      { id: "slide-after", caption: "보정 후", note: "줄간격 1.55, 장 유형과 순서 단추가 보임" },
    ],
    referenceSummary: "장 유형과 순서 변경, 줄간격 1.32에서 1.55 보정 결과.",
    assignee: { name: "로젤린", role: "구현", session: "구현 세션", agentId: "roselin" },
    messages: [
      { role: "user", text: "슬라이드 장 유형과 순서를 바꿀 수 있게 해 줘. 줄간격도 좁아 보여.", time: "11월 17일 오전 10:20" },
      { role: "assistant", text: "장 유형 전환과 순서 변경을 넣고, 본문 줄간격을 1.55로 맞췄습니다.", time: "11월 18일 오후 4:05" },
      { role: "assistant", text: "인쇄 미리보기와 20장 이상 성능은 확인하지 못했습니다.", time: "11월 18일 오후 4:06" },
    ],
  },
  {
    id: "1112",
    number: 1112,
    kind: "review",
    kindLabel: "검수 대기",
    subLabel: "관찰",
    folder: folderName("folder-kaleidoscope"),
    folderId: "folder-kaleidoscope",
    age: "8일째 대기",
    title: "kaleidoscope 할 일 앱 이전과 아침 예약 알림 연동",
    request: "할 일 앱을 새 화면으로 옮기고, 아침 예약 알림이 새 화면에서도 오도록 연결해 주세요.",
    checks: [
      { id: 1, title: "할 일 앱 이전", result: "기존 목록과 완료 표시가 새 화면에서 그대로 보입니다." },
      { id: 2, title: "아침 예약 알림 연결", result: "평일 08:30 예약이 주말을 빼고 도착하는 것을 확인했습니다." },
    ],
    unverified: "일주일 이상 지난 예약과 앱이 꺼진 상태의 알림은 실제로 보지 못했습니다.",
    evidence: [
      { id: "tree", caption: "트리 연동", note: "평일 08:30 예약, 주말 제외 시간표" },
    ],
    referenceSummary: "평일 08:30 예약과 주말 제외 시간표 연동 결과.",
    assignee: { name: "로젤린", role: "관찰", session: "관찰 세션", agentId: "roselin" },
    messages: [
      { role: "user", text: "할 일 앱을 새 화면으로 옮기고 아침 알림도 이어지게 해 줘.", time: "11월 11일 오전 9:30" },
      { role: "assistant", text: "목록과 완료 표시를 옮기고, 평일 08:30 예약 알림을 새 화면에 연결했습니다.", time: "11월 11일 오후 5:12" },
      { role: "assistant", text: "일주일 이상 지난 예약과 앱이 꺼진 상태는 확인하지 못했습니다.", time: "11월 11일 오후 5:13" },
    ],
  },
];

export const PROGRESS_CARDS: ScenarioCard[] = [
  {
    id: "card-1698", number: 1698, title: "보드 확대 초점 링과 폴더 오류 빈 목록 화면",
    folder: folderName("folder-soulstream"), folderId: "folder-soulstream", status: "running", color: "blue", activityKind: "report",
    activity: "확대 초점 링을 고치고 폴더 오류 빈 목록을 확인하는 중입니다.",
    assignee: { name: "로젤린", role: "구현", session: "구현 세션", agentId: "roselin" }, createdAt: createdAt(18),
  },
  {
    id: "card-1702", number: 1702, title: "PAS 보고 창 요약 줄 접기",
    folder: folderName("folder-soulstream"), folderId: "folder-soulstream", status: "running", color: "mint", activityKind: "report",
    activity: "긴 보고 요약을 두 줄에서 접히도록 맞추고 있습니다.",
    assignee: { name: "로젤린", role: "구현", session: "구현 세션", agentId: "roselin" }, createdAt: createdAt(18),
  },
  {
    id: "card-1705", number: 1705, title: "세션 재연결 뒤 새 턴 복구",
    folder: folderName("folder-soulstream"), folderId: "folder-soulstream", status: "running", color: "lavender", activityKind: "instruction",
    activity: "재연결 뒤 새 턴이 빠지지 않는지 확인하고 있습니다.",
    assignee: { name: "로젤린", role: "구현", session: "구현 세션", agentId: "roselin" }, createdAt: createdAt(18),
  },
];

export const QUEUE_CARDS: ScenarioCard[] = [
  {
    id: "card-1709", number: 1709, title: "웹훅 MCP 도구 이름 정리",
    folder: folderName("folder-soulstream"), folderId: "folder-soulstream", status: "queued", color: "yellow", activityKind: "instruction",
    activity: "도구 이름을 한 가지 규칙으로 맞춥니다.",
    assignee: { name: "로젤린", role: "구현", session: "대기", agentId: "roselin" }, createdAt: createdAt(18),
  },
  {
    id: "card-1710", number: 1710, title: "카드 보드 좁은 폭 열 너비",
    folder: folderName("folder-soulstream"), folderId: "folder-soulstream", status: "queued", color: "pink", activityKind: "instruction",
    activity: "좁은 폭에서 열 너비가 무너지지 않게 맞춥니다.",
    assignee: { name: "로젤린", role: "구현", session: "대기", agentId: "roselin" }, createdAt: createdAt(18),
  },
];

const HOLD_TITLES = [
  "웹훅 MCP 도구 여덟 개 구현",
  "문서 패널 상태 복원",
  "보드 판 이동 단축키",
  "슬라이드 내보내기 이름 규칙",
  "폴더 보관 확인 문구",
  "세션 목록 빈 상태",
  "카드 색 대비 점검",
  "알림 소리 설정",
  "첨부 그림 대체 텍스트",
  "검색 단축키 충돌",
  "PAS 설정 저장 표시",
  "보드 확대 배율 기억",
  "문서 인쇄 여백",
  "카드 복제 이름",
  "세션 이름 길이",
  "폴더 이동 경로",
  "완료 목록 날짜 칩",
  "오류 안내 다시 시도",
];

export const ON_HOLD_CARDS: ScenarioCard[] = HOLD_TITLES.map((title, index) => ({
  id: `card-hold-${index + 1}`,
  number: 1458 - index * 7,
  title,
  folder: folderName(index % 2 === 0 ? "folder-soulstream" : "folder-kaleidoscope"),
  folderId: index % 2 === 0 ? "folder-soulstream" : "folder-kaleidoscope",
  status: "on_hold",
  color: (["yellow", "pink", "mint", "blue", "lavender"] as const)[index % 5],
  activityKind: "instruction",
  activity: "다음 판에서 다시 봅니다.",
  assignee: { name: "로젤린", role: "보류", session: "보류", agentId: "roselin" as const },
  createdAt: createdAt(10),
}));

const COMPLETED_NORMAL: [number, string, CardColor][] = [
  [1666, "카드 보드 완료 칸 접힘 상태", "mint"],
  [1640, "PAS 보고 창 빈 상태 안내", "blue"],
  [1612, "세션 목록 날짜 구분선", "lavender"],
  [1588, "폴더 카드 로딩 자리", "yellow"],
  [1554, "검색 결과 강조 표시", "pink"],
  [1520, "보드 초점 링 두께", "mint"],
  [1490, "카드 댓글 입력 자리", "blue"],
  [1462, "슬라이드 미리보기 여백", "lavender"],
  [1430, "알림 기록 정렬", "yellow"],
];

const COMPLETED_REFERENCE: [number, string, CardColor, string][] = [
  [1310, "모던 웹 가이드 도입 정리", "blue", "모던 웹 가이드의 기준과 예외를 한 장으로 정리했습니다."],
  [1250, "카드 보드 접근성 점검", "mint", "카드 보드의 초점 순서와 대비 점검 결과를 남겼습니다."],
  [1188, "PAS 보고 창 읽기 폭 정리", "lavender", "PAS 보고 창의 읽기 폭을 세 안으로 비교한 조사서입니다."],
];

export const COMPLETED_CARDS: ScenarioCard[] = [
  ...COMPLETED_REFERENCE.map(([number, title, color, activity]) => ({
    id: `card-${number}`, number, title,
    folder: folderName("folder-soulstream"), folderId: "folder-soulstream",
    status: "done" as const, color,
    activityKind: "report" as const, activity, reference: true,
    assignee: { name: "로젤린", role: "완료", session: "참고 서재", agentId: "roselin" as const }, createdAt: createdAt(4),
  })),
  ...COMPLETED_NORMAL.map(([number, title, color]) => ({
    id: `card-${number}`, number, title,
    folder: folderName("folder-soulstream"), folderId: "folder-soulstream",
    status: "done" as const, color,
    activityKind: "report" as const, activity: "확인 항목을 모두 마쳤습니다.",
    assignee: { name: "로젤린", role: "완료", session: "완료 세션", agentId: "roselin" as const }, createdAt: createdAt(8),
  })),
];

export function toCardRow(card: ScenarioCard): CardRow {
  return {
    id: card.id,
    number: card.number,
    folderId: card.folderId,
    title: card.title,
    request: card.activity,
    brief: card.activity,
    attachments: [],
    status: card.status,
    color: card.color,
    blockedKind: null,
    blockedDetail: null,
    positionKey: String(card.number),
    queuePositionKey: card.status === "queued" ? String(card.number) : null,
    assigneeKind: "agent",
    assigneeAgentId: card.assignee.agentId,
    assigneeUserId: null,
    assigneeSessionId: null,
    nodeId: "eiaserinnys",
    modelPreset: null,
    version: 1,
    archived: false,
    createdAt: card.createdAt,
    updatedAt: card.createdAt,
    latestActivity: {
      kind: card.activityKind,
      body: card.activity,
      createdAt: card.createdAt,
      format: "markdown",
    },
  };
}

export function pendingCard(doc: PendingDoc): ScenarioCard {
  return {
    id: `card-${doc.number}`,
    number: doc.number,
    title: doc.title,
    folder: doc.folder,
    folderId: doc.folderId,
    status: doc.kind === "question" ? "blocked" : doc.kind === "task" ? "queued" : "review",
    color: doc.kind === "question" ? "yellow" : doc.kind === "task" ? "mint" : "blue",
    activityKind: doc.kind === "review" ? "report" : "instruction",
    activity: doc.request,
    assignee: doc.assignee,
    createdAt: createdAt(15),
  };
}

export function docCardRow(doc: PendingDoc): CardRow {
  return toCardRow(pendingCard(doc));
}

export const PAS_MESSAGES: SessionMessage[] = [
  { role: "assistant", text: "어젯밤에 설계 문서와 슬라이드 수정이 올라왔습니다. 결재 서류 다섯 건, 지금 넘길까요?", time: "오전 7:55" },
  { role: "user", text: "응, 결재 데스크로 가져와 줘.", time: "오전 7:56" },
  { role: "assistant", text: "결재 데스크에 놓았습니다. 넘긴 서류는 보류함으로 보내지 않고 진행 중이나 참고 서재로 옮깁니다.", time: "오전 7:57" },
];
