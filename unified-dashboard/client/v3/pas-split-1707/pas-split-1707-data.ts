/** 시안 B 의 결재 서류 데이터. 회사 업무나 민감 정보 없이 시나리오만 담는다. */
import type { CatalogFolder, SessionSummary } from "@seosoyoung/soul-ui";
import type { CardDetail, CardRow, CardStatus } from "@seosoyoung/soul-ui/cards/card-types";

export type AgendaKind = "질문" | "부탁" | "설계서" | "구현" | "관찰";
export type AgendaStatus = "pending" | "running" | "awaiting" | "done";
export type AgendaActionId = "approve" | "promote" | "verify3" | "verifyEvening";
export type EvidenceKind = "range" | "version" | "flow" | "slide" | "days";

export interface AgendaCheck {
  id: string;
  label: string;
}

export interface QuestionOption {
  label: string;
  recommended?: boolean;
}

export interface Agenda {
  id: string;
  number: number;
  kind: AgendaKind;
  title: string;
  excerpt: string;
  requester: string;
  requestedAt: string;
  checks: AgendaCheck[];
  evidence: { kind: EvidenceKind; label: string; caption: string };
  primary: { id: AgendaActionId; label: string } | null;
  question?: { label: string; options: QuestionOption[] };
  status: AgendaStatus;
}

export const AGENDAS: Agenda[] = [
  {
    id: "agenda-1680",
    number: 1680,
    kind: "질문",
    title: "완료 목록 기간 칩의 기본 범위",
    excerpt: "완료 목록에서 기간 칩이 처음 열릴 때 어떤 범위를 기본으로 보여 주면 좋을지 정해 주세요. 지금은 7일이 기본입니다.",
    requester: "서소영",
    requestedAt: "11월 18일 21:40",
    checks: [
      { id: "chip-order", label: "기간 칩이 7일, 14일, 30일 순서로 보입니다" },
      { id: "range-only", label: "고른 기간의 완료 카드만 목록에 남습니다" },
    ],
    evidence: { kind: "range", label: "기간 칩 선택 분포", caption: "최근 30일 선택 분포, 7일 62%, 14일 27%, 30일 11%" },
    primary: null,
    question: {
      label: "기본 범위",
      options: [
        { label: "7일 유지", recommended: true },
        { label: "14일로 변경" },
        { label: "30일로 변경" },
      ],
    },
    status: "pending",
  },
  {
    id: "agenda-1512",
    number: 1512,
    kind: "부탁",
    title: "집 PC kaleidoscope 사용량 앱 수동 업데이트",
    excerpt: "집 PC의 kaleidoscope 사용량 앱이 예전 버전입니다. 시간 될 때 수동으로 업데이트해 주세요.",
    requester: "서소영",
    requestedAt: "11월 18일 19:05",
    checks: [
      { id: "installed-version", label: "집 PC 설치본이 0.9.4입니다" },
      { id: "installer-ready", label: "새 설치 파일을 내려받을 수 있습니다" },
    ],
    evidence: { kind: "version", label: "설치본과 최신 버전", caption: "설치본 0.9.4, 최신 0.9.7, 사용량 동기화는 정상" },
    primary: { id: "verifyEvening", label: "저녁에 재확인" },
    status: "pending",
  },
  {
    id: "agenda-1387",
    number: 1387,
    kind: "설계서",
    title: "턴 안 상호작용 3단계 도입 설계안",
    excerpt: "턴 안 상호작용을 접수, 분류, 실행 세 단계로 나누는 설계안을 검토해 주세요. 구현 전에 방향만 정하면 됩니다.",
    requester: "서소영",
    requestedAt: "11월 18일 16:22",
    checks: [
      { id: "three-steps", label: "접수, 분류, 실행 세 단계가 카드 흐름 안에서 이어집니다" },
      { id: "overlap", label: "기존 PAS 보고와 겹치는 부분을 정리했습니다" },
    ],
    evidence: { kind: "flow", label: "3단계 흐름도", caption: "접수, 분류, 실행 세 단계와 카드 상태의 연결" },
    primary: { id: "promote", label: "폴더 문서로 남기고 완료" },
    status: "pending",
  },
  {
    id: "agenda-1408",
    number: 1408,
    kind: "구현",
    title: "슬라이드 편집 장 유형, 순서 변경, 줄간격 보정",
    excerpt: "슬라이드 편집 화면에서 장 유형을 바꾸고 순서를 옮기는 동작, 줄간격 보정까지 확인해 주세요.",
    requester: "서소영",
    requestedAt: "11월 18일 14:10",
    checks: [
      { id: "type-kept", label: "장 유형 전환이 편집 중에도 유지됩니다" },
      { id: "order-save", label: "순서를 바꾼 뒤 저장까지 이어집니다" },
      { id: "line-height", label: "줄간격 보정이 발행 화면과 같습니다" },
      { id: "narrow-tools", label: "좁은 폭에서 도구 줄이 겹치지 않습니다" },
    ],
    evidence: { kind: "slide", label: "장 순서 변경 전후", caption: "장 순서를 바꾼 뒤에도 줄간격 1.6과 발행 미리보기가 같습니다" },
    primary: { id: "approve", label: "승인 완료" },
    status: "pending",
  },
  {
    id: "agenda-1112",
    number: 1112,
    kind: "관찰",
    title: "할 일 앱 이전과 아침 예약 알림 연동",
    excerpt: "할 일 앱 이전 뒤 아침 예약 알림이 잘 오는지 며칠 지켜봐 주세요.",
    requester: "서소영",
    requestedAt: "11월 17일 22:48",
    checks: [
      { id: "tasks-kept", label: "이전 뒤 할 일 12건이 그대로 보입니다" },
      { id: "morning-alert", label: "아침 7시 예약 알림이 한 번 도착했습니다" },
    ],
    evidence: { kind: "days", label: "사흘 알림 기록", caption: "이전 뒤 사흘 동안 아침 알림이 모두 도착했습니다" },
    primary: { id: "verify3", label: "3일 뒤 재확인" },
    status: "pending",
  },
];

export interface TaskCard {
  id: string;
  number: number;
  title: string;
  meta: string;
}

export const RUNNING_CARDS: TaskCard[] = [
  { id: "card-1690", number: 1690, title: "세션 재시작 뒤 새 턴 복구 확인", meta: "진행 중, 40분 전" },
  { id: "card-1695", number: 1695, title: "작업 목록 그룹 접힘 기억", meta: "진행 중, 1시간 전" },
  { id: "card-1701", number: 1701, title: "보드 확대 초점 링 정리", meta: "진행 중, 2시간 전" },
];

export const AWAITING_CARDS: TaskCard[] = [
  { id: "card-1677", number: 1677, title: "완료 칩 색 대비 관찰", meta: "검증 대기, 11월 17일" },
];

export const QUEUED_CARDS: TaskCard[] = [
  { id: "card-1712", number: 1712, title: "문서 리더 목차", meta: "대기열, 오늘 16:00" },
  { id: "card-1716", number: 1716, title: "폴더 문서 이름 변경", meta: "대기열, 오늘 18:00" },
];

export const HOLD_COUNT = 18;

export interface FolderDocument {
  id: string;
  folderId: string;
  title: string;
  date: string;
  summary: string;
}

export const FOLDER_DOCUMENTS: FolderDocument[] = [
  {
    id: "doc-pas-approval-notes",
    folderId: "folder-soulstream",
    title: "PAS 결재 뷰 요구 정리",
    date: "11월 12일",
    summary: "질문과 검수 대기를 서류처럼 넘기는 흐름의 요구를 모았습니다.",
  },
  {
    id: "doc-board-focus-ring",
    folderId: "folder-soulstream",
    title: "보드 확대 초점 링 점검 기록",
    date: "11월 16일",
    summary: "보드 확대에서 초점 링이 잘리던 자리와 수정 범위를 적었습니다.",
  },
  {
    id: "doc-kaleidoscope-usage",
    folderId: "folder-kaleidoscope",
    title: "kaleidoscope 사용량 앱 업데이트 기록",
    date: "11월 18일",
    summary: "집 PC 설치본과 최신 버전 차이, 수동 업데이트 순서를 적었습니다.",
  },
];

export const PROMOTED_DOCUMENT: FolderDocument = {
  id: "doc-turn-interaction-design",
  folderId: "folder-soulstream",
  title: "턴 안 상호작용 3단계 도입 설계안",
  date: "11월 19일",
  summary: "접수, 분류, 실행 세 단계로 턴 안 확인을 나누는 설계입니다.",
};

export interface ChatTurn {
  id: string;
  role: "assistant" | "user" | "system";
  text: string;
  time: string;
  target?: string;
}

export const INITIAL_CHAT: ChatTurn[] = [
  {
    id: "chat-1",
    role: "assistant",
    text: "오늘 결재할 서류 다섯 건을 올렸습니다. 왼쪽에서 읽고, 오른쪽에 지시를 남겨 주세요.",
    time: "09:12",
  },
  {
    id: "chat-2",
    role: "user",
    text: "#1408 슬라이드 편집은 장 순서를 바꾸는 부분부터 볼게요.",
    time: "09:18",
  },
  {
    id: "chat-3",
    role: "assistant",
    text: "#1408 2번 항목은 저장 흐름을 더 봐야 합니다. 서류의 확인 항목에서 바로 지시할 수 있습니다.",
    time: "09:19",
  },
  {
    id: "chat-4",
    role: "assistant",
    text: "질문은 추천 선택지를 바로 누르거나, 되묻기나 자유 응답으로 이어서 말할 수 있습니다.",
    time: "09:21",
  },
];

/** 폴더 문서 리더가 읽는 본문. 문서 id가 그대로 API 경로가 된다. */
export const DOCUMENT_BODIES: Record<string, { id: string; title: string; body: string; version: number; createdAt: string; updatedAt: string }> = {
  "doc-pas-approval-notes": {
    id: "doc-pas-approval-notes",
    title: "PAS 결재 뷰 요구 정리",
    version: 3,
    createdAt: "2026-11-12T09:00:00Z",
    updatedAt: "2026-11-12T09:00:00Z",
    body: [
      "## 배경",
      "카드 뷰는 세션 단위 추적보다 낫지만, 내용을 알려면 여전히 여러 뎁스를 열어야 합니다.",
      "",
      "## 요구",
      "- 질문과 검수 대기를 결재 서류처럼 넘기는 한 화면",
      "- 서류를 읽는 동안 바로 지시를 남기는 입력창",
      "- 보류함을 늘리지 않고 애매한 안건을 소화하는 처분",
      "",
      "## 결정",
      "미결재 서류판과 원고지 대화창을 좌우로 두고, 처분 도장으로 다음 서류로 넘어간다.",
    ].join("\n"),
  },
  "doc-board-focus-ring": {
    id: "doc-board-focus-ring",
    title: "보드 확대 초점 링 점검 기록",
    version: 2,
    createdAt: "2026-11-16T11:30:00Z",
    updatedAt: "2026-11-16T11:30:00Z",
    body: [
      "## 본 것",
      "보드를 확대한 화면에서 초점 링이 카드 경계 밖에서 잘렸습니다.",
      "",
      "## 원인",
      "확대 컨테이너가 overflow hidden을 두르고 있었습니다.",
      "",
      "## 처리",
      "초점 링이 필요한 카드에 여백을 두고, 확대 배율을 바꿀 때 초점을 유지했습니다.",
    ].join("\n"),
  },
  "doc-kaleidoscope-usage": {
    id: "doc-kaleidoscope-usage",
    title: "kaleidoscope 사용량 앱 업데이트 기록",
    version: 1,
    createdAt: "2026-11-18T10:10:00Z",
    updatedAt: "2026-11-18T10:10:00Z",
    body: [
      "## 확인",
      "집 PC 설치본은 0.9.4이고 최신 버전은 0.9.7입니다.",
      "",
      "## 순서",
      "1. 새 설치 파일을 내려받습니다.",
      "2. 기존 앱을 닫고 설치 파일을 실행합니다.",
      "3. 사용량 동기화가 다시 도는지 확인합니다.",
      "",
      "## 남은 일",
      "저녁에 한 번 더 열어 동기화 상태를 봅니다.",
    ].join("\n"),
  },
  "doc-turn-interaction-design": {
    id: "doc-turn-interaction-design",
    title: "턴 안 상호작용 3단계 도입 설계안",
    version: 1,
    createdAt: "2026-11-19T03:20:00Z",
    updatedAt: "2026-11-19T03:20:00Z",
    body: [
      "## 요약",
      "턴이 끝나기 전에 사용자의 확인을 받아야 하는 순간을 세 단계로 나눕니다.",
      "",
      "## 단계",
      "1. 접수: 발신자가 남긴 요청을 카드 항목으로 옮깁니다.",
      "2. 분류: 질문, 부탁, 설계서, 구현, 관찰 중 하나로 나눕니다.",
      "3. 실행: 분류에 맞는 처분 도장을 고릅니다.",
      "",
      "## 기존 흐름과 다른 점",
      "- 결재 서류판은 미결재 안건만 보여 줍니다.",
      "- 처분이 끝난 안건은 폴더 문서나 검증 대기로 빠집니다.",
      "- 보류함은 18건 아래로 늘리지 않습니다.",
      "",
      "## 다음 작업",
      "폴더 문서 승격 뒤 문서 목록에서 바로 읽을 수 있는지 확인합니다.",
    ].join("\n"),
  },
};

/** 홈 플래너의 폴더 트리. 프로젝트 폴더와 같은 모양을 쓴다. */
export const HOME_FOLDERS: CatalogFolder[] = [
  { id: "folder-soulstream", name: "✨ 소울스트림", parentFolderId: null, sortOrder: 0, status: "open", version: 1, archived: false },
  { id: "folder-pas", name: "PAS 결재", parentFolderId: "folder-soulstream", sortOrder: 0, status: "open", version: 1, archived: false },
  { id: "folder-kaleidoscope", name: "🔮 kaleidoscope", parentFolderId: null, sortOrder: 1, status: "open", version: 1, archived: false },
];

export type HomeAgentId = "seosoyoung" | "roselin" | "keke" | "selaphiel";

export const HOME_AGENTS: Record<HomeAgentId, { name: string }> = {
  seosoyoung: { name: "서소영" },
  roselin: { name: "로젤린" },
  keke: { name: "케케" },
  selaphiel: { name: "세라피엘" },
};

const MOCK_NOW = "2026-11-19T06:00:00Z";

/** 카드 초상은 에이전트별 API 주소를 그대로 쓰고, mock-env가 파일로 바꾼다. */
export function homeAssignee(agentId: HomeAgentId): SessionSummary {
  return {
    agentSessionId: `mockup-session-${agentId}`,
    displayName: HOME_AGENTS[agentId].name,
    status: "completed",
    eventCount: 0,
    agentId,
    agentName: HOME_AGENTS[agentId].name,
    nodeId: "eiaserinnys",
    modelLabel: "Sol",
    backend: "codex",
    prompt: "홈 플래너 초상 시안",
    createdAt: MOCK_NOW,
    updatedAt: MOCK_NOW,
  } as SessionSummary;
}

const HOLD_TITLES = [
  "기간 칩 문구 확인",
  "보드 초점 링 재확인",
  "문서 리더 목차 폭",
  "세션 복구 안내 문구",
  "카드 상태 칩 대비",
  "대화 입력창 높이",
  "폴더 이름 긴 줄임",
  "완료 목록 날짜 경계",
  "알림 문구 두 줄",
  "작업 목록 접힘 기억",
  "보드 확대 배율",
  "문서 이름 변경 초점",
  "초상 테두리 색",
  "입력창 안내 문구",
  "카드 열 최소 폭",
  "좁은 화면 탭 순서",
  "보류함 정리 기준",
  "완료 카드 되돌리기",
];

interface HomeCardSeed {
  number: number;
  status: CardStatus;
  folderId: string;
  title: string;
  agent: HomeAgentId;
}

const HOME_CARD_SEEDS: HomeCardSeed[] = [
  { number: 1702, status: "awaiting_verification", folderId: "folder-soulstream", title: "완료 칩 색 대비 관찰", agent: "selaphiel" },
  { number: 1704, status: "awaiting_verification", folderId: "folder-soulstream", title: "보드 확대 초점 링 확인", agent: "roselin" },
  { number: 1690, status: "running", folderId: "folder-soulstream", title: "세션 재시작 뒤 새 턴 복구", agent: "seosoyoung" },
  { number: 1695, status: "running", folderId: "folder-soulstream", title: "작업 목록 그룹 접힘 기억", agent: "keke" },
  { number: 1701, status: "running", folderId: "folder-soulstream", title: "보드 확대 초점 링 정리", agent: "roselin" },
  ...HOLD_TITLES.map((title, index): HomeCardSeed => ({
    number: 1720 + index,
    status: "on_hold",
    folderId: "folder-soulstream",
    title,
    agent: (["seosoyoung", "roselin", "keke", "selaphiel"] as HomeAgentId[])[index % 4],
  })),
  { number: 1677, status: "done", folderId: "folder-soulstream", title: "완료 칩 문구 정리", agent: "seosoyoung" },
  { number: 1682, status: "done", folderId: "folder-soulstream", title: "문서 리더 여백 정리", agent: "selaphiel" },
  { number: 1712, status: "running", folderId: "folder-kaleidoscope", title: "사용량 앱 동기화 확인", agent: "keke" },
  { number: 1716, status: "running", folderId: "folder-kaleidoscope", title: "사용량 그래프 기간 칩", agent: "roselin" },
  { number: 1719, status: "awaiting_verification", folderId: "folder-pas", title: "PAS 결재 서류판 문구", agent: "selaphiel" },
];

export const HOME_CARDS: CardRow[] = HOME_CARD_SEEDS.map((seed, index) => ({
  id: `home-card-${seed.number}`,
  number: seed.number,
  folderId: seed.folderId,
  title: seed.title,
  request: `${seed.title} 요청을 확인하고 결과를 남깁니다.`,
  brief: "",
  attachments: [],
  status: seed.status,
  blockedKind: null,
  blockedDetail: null,
  positionKey: `${seed.status}-${String(index).padStart(2, "0")}`,
  queuePositionKey: null,
  assigneeKind: "agent",
  assigneeAgentId: seed.agent,
  assigneeUserId: null,
  assigneeSessionId: null,
  nodeId: "eiaserinnys",
  modelPreset: "Sol",
  version: 1,
  archived: false,
  createdAt: MOCK_NOW,
  updatedAt: MOCK_NOW,
  completedAt: seed.status === "done" ? MOCK_NOW : null,
  latestActivity: {
    kind: "report",
    format: "markdown",
    body: `${seed.title} 진행 상황을 확인했습니다. 남은 확인 항목은 카드 상세에서 이어 봅니다.`,
    createdAt: MOCK_NOW,
  },
}));

export function homeCardDetail(card: CardRow): CardDetail {
  return {
    card,
    reports: [{
      id: `report-${card.id}`,
      title: "최근 보고",
      format: "markdown",
      body: [
        "## 확인한 것",
        `- ${card.title} 요청을 화면에서 다시 확인했습니다.`,
        "- 좁은 폭과 넓은 폭에서 같은 내용이 보입니다.",
        "",
        "## 다음",
        "- 남은 확인 항목을 카드 상세에서 이어 봅니다.",
      ].join("\n"),
      createdAt: MOCK_NOW,
      sessionId: null,
    }],
    questions: [],
    sessions: [],
    comments: [],
    notes: [],
    nowHistory: [],
  };
}
