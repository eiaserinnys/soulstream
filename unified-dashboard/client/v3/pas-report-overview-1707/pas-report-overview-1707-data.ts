/**
 * 시안 B(카드 전 요소 3열 조감판)의 결재 서류 데이터.
 * 실제 업무 내용이나 회사 자산 없이, 카드 5건의 모양만 재현한다.
 */
import type { MarkdownDocument } from "@seosoyoung/soul-ui";
import type { CardCheckItem, CardRow, CardStatus } from "@seosoyoung/soul-ui/cards/card-types";

export const MOCK_SESSION_ID = "mockup-pas-overview-1707";
export const MOCK_SESSION_TITLE = "PAS 검수 정리 세션";
export const MOCK_NOW = "2026-11-19T12:00:00Z";
export const HOLD_COUNT = 18;

export type OverviewAgentId = "roselin" | "keke" | "seosoyoung" | "selaphiel";
export type OverviewKind = "질문" | "부탁" | "설계서" | "구현" | "관찰";
export type EvidenceKind = "range" | "version" | "flow" | "slide" | "days";
export type OverviewActionEffect = "done" | "awaiting_verification" | "promote";

export interface OverviewAgent {
  id: OverviewAgentId;
  name: string;
  role: string;
}

export const AGENTS: Record<OverviewAgentId, OverviewAgent> = {
  roselin: { id: "roselin", name: "로젤린", role: "코드 구현" },
  keke: { id: "keke", name: "키키", role: "진단과 관측" },
  seosoyoung: { id: "seosoyoung", name: "서소영", role: "설계와 지휘" },
  selaphiel: { id: "selaphiel", name: "세라피엘", role: "화면 구현" },
};

/** 카드 초상은 에이전트별 API 주소를 쓰고, mock-env가 묶음 안 파일로 바꾼다. */
export function agentPortrait(agentId: OverviewAgentId) {
  return `/api/nodes/eiaserinnys/agents/${agentId}/portrait`;
}

export interface OverviewComment {
  id: string;
  author: "user" | "agent";
  authorName: string;
  at: string;
  body: string;
  itemId?: number | null;
  question?: boolean;
}

export interface OverviewTurn {
  id: string;
  role: "assistant" | "user";
  author: string;
  time: string;
  text: string;
}

export interface OverviewOption {
  label: string;
  description: string;
  recommended?: boolean;
}

export interface OverviewEvidence {
  kind: EvidenceKind;
  label: string;
  caption: string;
}

export interface OverviewAction {
  label: string;
  effect: OverviewActionEffect;
}

export interface OverviewQuestion {
  background: string;
  kind: "choice" | "request";
  options: OverviewOption[];
}

export interface OverviewScenario {
  id: string;
  number: number;
  kind: OverviewKind;
  title: string;
  request: string;
  agent: OverviewAgentId;
  sessionTitle: string;
  status: CardStatus;
  blockedKind: "question" | null;
  items: CardCheckItem[];
  evidence: OverviewEvidence;
  comments: OverviewComment[];
  turns: OverviewTurn[];
  outcome: string;
  question: OverviewQuestion | null;
  primary: OverviewAction | null;
  secondary: OverviewAction | null;
  documentId?: string;
}

function checkItem(id: number, title: string, result: string, caveat: string | null = null): CardCheckItem {
  return {
    id,
    title,
    state: "done",
    result,
    evidence: [],
    caveat,
    rev: 1,
    confirmed: null,
    fixOpen: 0,
    reopened: null,
    from: null,
    createdAt: MOCK_NOW,
    reportedAt: MOCK_NOW,
    display: "reported",
  };
}

export const OVERVIEW_SCENARIOS: OverviewScenario[] = [
  {
    id: "overview-1680",
    number: 1680,
    kind: "질문",
    title: "완료 목록 기간 칩의 기본 범위",
    request: "완료 목록에서 기간 칩이 처음 열릴 때 어떤 범위를 기본으로 보여 주면 좋을지 정해 주세요. 지금은 최근 7일이 기본입니다.",
    agent: "roselin",
    sessionTitle: "완료 목록 기간 집계 세션",
    status: "blocked",
    blockedKind: "question",
    items: [
      checkItem(1, "기간 칩이 7일, 14일, 30일 순서로 보입니다", "칩 순서와 기본 선택을 확인했습니다."),
      checkItem(2, "고른 기간의 완료 카드만 목록에 남습니다", "7일과 14일 전환에서 목록이 다시 그려집니다."),
    ],
    evidence: {
      kind: "range",
      label: "최근 30일 완료 142건의 기간 분포",
      caption: "7일 88건, 14일 38건, 30일 16건",
    },
    comments: [
      {
        id: "c-1680-1",
        author: "user",
        authorName: "서소영",
        at: "11월 18일 21:52",
        body: "기간 칩 기본값이 왜 7일인지 궁금합니다. 최근에 실제로 어떤 기간을 많이 쓰는지 봤나요?",
      },
      {
        id: "c-1680-2",
        author: "agent",
        authorName: "로젤린",
        at: "11월 18일 21:58",
        body: "최근 30일 완료 142건 가운데 7일 안에 끝난 카드가 88건입니다. 14일은 38건, 30일은 16건입니다.",
        question: true,
      },
    ],
    turns: [
      {
        id: "t-1680-1",
        role: "user",
        author: "서소영",
        time: "21:40",
        text: "완료 목록 기간 칩 기본값을 정하려고 합니다. 최근 30일 완료 카드 분포를 먼저 봐 주세요.",
      },
      {
        id: "t-1680-2",
        role: "assistant",
        author: "로젤린",
        time: "21:46",
        text: "최근 30일 완료 142건을 집계했습니다. 7일 88건, 14일 38건, 30일 16건입니다.",
      },
      {
        id: "t-1680-3",
        role: "assistant",
        author: "로젤린",
        time: "21:48",
        text: "7일 기본값이 가장 자주 쓰입니다. 다만 14일을 고르는 흐름도 27%라 선택지를 함께 두는 편이 낫습니다.",
      },
    ],
    outcome: "기간 분포 집계와 선택지 3개를 카드에 올렸습니다.",
    question: {
      kind: "choice",
      background: "완료 목록의 기간 칩 기본값을 정해 주세요. 최근 30일 완료 142건 가운데 7일 안에 끝난 카드가 88건입니다.",
      options: [
        { label: "최근 7일", description: "완료 142건 가운데 88건이 7일 안에 끝났습니다.", recommended: true },
        { label: "최근 14일", description: "14일 안에 끝난 카드는 38건입니다." },
        { label: "전체 기간", description: "30일 기준으로 남은 카드는 16건입니다." },
      ],
    },
    primary: null,
    secondary: null,
  },
  {
    id: "overview-1512",
    number: 1512,
    kind: "부탁",
    title: "집 PC kaleidoscope 사용량 앱 수동 업데이트",
    request: "집 PC의 kaleidoscope 사용량 앱이 예전 버전입니다. 시간 될 때 수동으로 업데이트해 주세요.",
    agent: "keke",
    sessionTitle: "kaleidoscope 사용량 진단 세션",
    status: "review",
    blockedKind: null,
    items: [
      checkItem(1, "집 PC 설치본이 0.9.4입니다", "설치 기록에서 0.9.4를 확인했습니다."),
      checkItem(2, "새 설치 파일을 내려받을 수 있습니다", "0.9.7 설치 파일을 준비했습니다."),
    ],
    evidence: {
      kind: "version",
      label: "설치본과 최신 버전",
      caption: "설치본 0.9.4, 최신 0.9.7, 사용량 동기화는 정상",
    },
    comments: [
      {
        id: "c-1512-1",
        author: "user",
        authorName: "서소영",
        at: "11월 18일 19:05",
        body: "집 PC 앱이 자동 업데이트가 안 붙는 것 같아요. 지금 버전을 확인해 주세요.",
      },
      {
        id: "c-1512-2",
        author: "agent",
        authorName: "키키",
        at: "11월 18일 19:12",
        body: "설치본은 0.9.4이고 최신은 0.9.7입니다. 동기화는 정상이라 수동으로 한 번 올리면 됩니다.",
      },
    ],
    turns: [
      {
        id: "t-1512-1",
        role: "user",
        author: "서소영",
        time: "19:05",
        text: "집 PC kaleidoscope 사용량 앱 버전을 확인해 주세요.",
      },
      {
        id: "t-1512-2",
        role: "assistant",
        author: "키키",
        time: "19:09",
        text: "설치본 0.9.4, 최신 0.9.7입니다. 자동 업데이트 기록이 없습니다.",
      },
      {
        id: "t-1512-3",
        role: "assistant",
        author: "키키",
        time: "19:11",
        text: "수동 설치 파일을 준비해 두었습니다. 설치 뒤 사용량 동기화가 다시 도는지 보면 됩니다.",
      },
    ],
    outcome: "설치 파일 준비와 수동 업데이트 순서를 정리했습니다.",
    question: {
      kind: "request",
      background: "집 PC 설치본이 0.9.4이고 최신은 0.9.7입니다. 수동으로 한 번 올리면 사용량 동기화가 다시 돕니다.",
      options: [],
    },
    primary: { label: "했어", effect: "done" },
    secondary: { label: "저녁에 다시 보기", effect: "awaiting_verification" },
  },
  {
    id: "overview-1387",
    number: 1387,
    kind: "설계서",
    title: "턴 안 상호작용 3단계 도입 설계안",
    request: "턴 안 상호작용을 접수, 분류, 실행 세 단계로 나누는 설계안을 검토해 주세요. 구현 전에 방향만 정하면 됩니다.",
    agent: "seosoyoung",
    sessionTitle: "턴 안 상호작용 설계 세션",
    status: "review",
    blockedKind: null,
    items: [
      checkItem(1, "접수, 분류, 실행 세 단계가 카드 흐름 안에서 이어집니다", "3단계 흐름과 카드 상태의 연결을 정리했습니다."),
      checkItem(2, "기존 PAS 보고와 겹치는 부분을 정리했습니다", "분류 단계의 유형 선택으로 흡수했습니다."),
    ],
    evidence: {
      kind: "flow",
      label: "3단계 흐름도",
      caption: "접수, 분류, 실행 세 단계와 카드 상태의 연결",
    },
    comments: [
      {
        id: "c-1387-1",
        author: "user",
        authorName: "서소영",
        at: "11월 18일 16:22",
        body: "구현 전에 방향만 정하면 됩니다. 기존 PAS 보고와 겹치는 부분이 궁금합니다.",
      },
      {
        id: "c-1387-2",
        author: "agent",
        authorName: "서소영",
        at: "11월 18일 16:40",
        body: "접수 단계는 지금의 카드 생성과 같고, 분류에서 유형을 고르고, 실행에서 처분 도장을 고르는 흐름으로 정리했습니다.",
      },
      {
        id: "c-1387-3",
        author: "user",
        authorName: "서소영",
        at: "11월 18일 17:05",
        body: "3단계로 나누면 검수 대기에 남는 시간이 줄어드는지도 문서에 적어 주세요.",
      },
    ],
    turns: [
      {
        id: "t-1387-1",
        role: "user",
        author: "서소영",
        time: "16:00",
        text: "턴 안 상호작용을 3단계로 나누는 설계안을 정리해 주세요.",
      },
      {
        id: "t-1387-2",
        role: "assistant",
        author: "서소영",
        time: "16:15",
        text: "접수, 분류, 실행 세 단계로 나누고 각 단계가 카드 상태와 어떻게 이어지는지 표로 만들었습니다.",
      },
      {
        id: "t-1387-3",
        role: "assistant",
        author: "서소영",
        time: "16:18",
        text: "기존 PAS 보고와 겹치는 부분은 분류 단계의 유형 선택으로 흡수했습니다.",
      },
    ],
    outcome: "접수, 분류, 실행 3단계 설계안과 기존 보고 흐름 정리.",
    question: null,
    primary: { label: "폴더 문서로 남기고 완료", effect: "promote" },
    secondary: null,
    documentId: "doc-turn-interaction-1707",
  },
  {
    id: "overview-1408",
    number: 1408,
    kind: "구현",
    title: "슬라이드 편집 장 유형, 순서 변경, 줄간격 보정",
    request: "슬라이드 편집 화면에서 장 유형을 바꾸고 순서를 옮기는 동작과 줄간격 보정까지 확인해 주세요.",
    agent: "selaphiel",
    sessionTitle: "슬라이드 편집 검수 세션",
    status: "review",
    blockedKind: null,
    items: [
      checkItem(1, "장 유형 전환이 편집 중에도 유지됩니다", "유형 전환 뒤 편집을 이어가도 유형이 유지됩니다."),
      checkItem(2, "순서를 바꾼 뒤 저장까지 이어집니다", "저장 시점에 순서 배열을 다시 읽습니다.", "1차 구현에서는 저장 뒤 처음 순서로 돌아갔습니다."),
      checkItem(3, "좁은 폭에서 도구 줄이 겹치지 않습니다", "좁은 폭에서 도구 줄을 두 줄로 정돈했습니다."),
    ],
    evidence: {
      kind: "slide",
      label: "장 순서 변경 전후",
      caption: "장 순서를 바꾼 뒤에도 줄간격 1.6과 발행 미리보기가 같습니다",
    },
    comments: [
      {
        id: "c-1408-1",
        author: "agent",
        authorName: "세라피엘",
        at: "11월 18일 14:10",
        body: "1차 구현을 올렸습니다. 장 유형 전환과 순서 저장까지 확인해 주세요.",
      },
      {
        id: "c-1408-2",
        author: "user",
        authorName: "서소영",
        at: "11월 18일 14:26",
        body: "2번 항목에서 순서를 바꾼 뒤 저장을 누르면 처음 순서로 돌아갑니다.",
        itemId: 2,
      },
      {
        id: "c-1408-3",
        author: "agent",
        authorName: "세라피엘",
        at: "11월 18일 15:02",
        body: "저장 시점에 순서 배열을 다시 읽도록 고쳤습니다. 줄간격도 발행 미리보기와 맞췄습니다.",
        itemId: 2,
      },
      {
        id: "c-1408-4",
        author: "user",
        authorName: "서소영",
        at: "11월 18일 15:20",
        body: "좁은 폭에서 도구 줄이 겹치는 건 아직 그대로입니다.",
        itemId: 3,
      },
    ],
    turns: [
      {
        id: "t-1408-1",
        role: "user",
        author: "서소영",
        time: "13:40",
        text: "슬라이드 편집 장 유형, 순서 변경, 줄간격 보정을 확인해 주세요.",
      },
      {
        id: "t-1408-2",
        role: "assistant",
        author: "세라피엘",
        time: "14:02",
        text: "장 유형 전환과 순서 저장을 구현했습니다. 좁은 폭 도구 줄은 아직 확인 중입니다.",
      },
      {
        id: "t-1408-3",
        role: "user",
        author: "서소영",
        time: "14:26",
        text: "저장하면 처음 순서로 돌아가는 문제가 있습니다.",
      },
      {
        id: "t-1408-4",
        role: "assistant",
        author: "세라피엘",
        time: "15:02",
        text: "순서 배열을 저장 시점에 다시 읽도록 고쳤고 줄간격을 발행 미리보기와 맞췄습니다.",
      },
    ],
    outcome: "장 순서 저장, 줄간격 1.6, 좁은 폭 도구 줄 보완.",
    question: null,
    primary: { label: "승인 완료", effect: "done" },
    secondary: null,
  },
  {
    id: "overview-1112",
    number: 1112,
    kind: "관찰",
    title: "할 일 앱 이전과 아침 예약 알림 연동",
    request: "할 일 앱 이전 뒤 아침 예약 알림이 잘 오는지 며칠 지켜봐 주세요.",
    agent: "keke",
    sessionTitle: "할 일 알림 관측 세션",
    status: "review",
    blockedKind: null,
    items: [
      checkItem(1, "이전 뒤 할 일 12건이 그대로 보입니다", "이전 목록에서 12건을 모두 확인했습니다."),
      checkItem(2, "아침 7시 예약 알림이 한 번 도착했습니다", "11월 17일부터 사흘 모두 도착했습니다."),
    ],
    evidence: {
      kind: "days",
      label: "사흘 아침 알림 기록",
      caption: "11월 17일, 18일, 19일 오전 7시에 알림이 모두 도착했습니다",
    },
    comments: [
      {
        id: "c-1112-1",
        author: "agent",
        authorName: "키키",
        at: "11월 17일 22:48",
        body: "이전 뒤 할 일 12건이 그대로 보입니다. 아침 7시 알림도 도착했습니다.",
      },
      {
        id: "c-1112-2",
        author: "user",
        authorName: "서소영",
        at: "11월 18일 08:10",
        body: "사흘 더 지켜보고 알려 주세요.",
      },
    ],
    turns: [
      {
        id: "t-1112-1",
        role: "user",
        author: "서소영",
        time: "22:48",
        text: "할 일 앱 이전 뒤 아침 예약 알림이 잘 오는지 봐 주세요.",
      },
      {
        id: "t-1112-2",
        role: "assistant",
        author: "키키",
        time: "07:05",
        text: "이전 뒤 할 일 12건이 그대로 남아 있고, 11월 18일 오전 7시 알림이 도착했습니다.",
      },
      {
        id: "t-1112-3",
        role: "assistant",
        author: "키키",
        time: "07:06",
        text: "사흘 기록을 모아 카드에 남기겠습니다.",
      },
    ],
    outcome: "사흘 아침 7시 알림 도착 기록.",
    question: null,
    primary: { label: "사흘 뒤 재확인", effect: "awaiting_verification" },
    secondary: null,
  },
];

export const DESIGN_DOCUMENT_ID = "doc-turn-interaction-1707";
export const PROMOTED_DOCUMENT_ID = "doc-turn-interaction-1707-folder";
export const PROMOTED_DOCUMENT_TITLE = "턴 안 상호작용 3단계 도입 설계안";

const DESIGN_DOCUMENT_BODY = [
  "## 요약",
  "턴이 끝나기 전에 사용자의 확인을 받아야 하는 순간을 접수, 분류, 실행 세 단계로 나눕니다.",
  "",
  "## 단계",
  "1. 접수: 발신자가 남긴 요청을 카드 항목으로 옮깁니다.",
  "2. 분류: 질문, 부탁, 설계서, 구현, 관찰 중 하나로 나눕니다.",
  "3. 실행: 분류에 맞는 처분 도장을 고릅니다.",
  "",
  "## 기존 흐름과 다른 점",
  "- 조감판은 미결 안건만 먼저 보여 줍니다.",
  "- 처분이 끝난 안건은 폴더 문서나 검증 대기로 빠집니다.",
  "- 보류함은 18건 아래로 늘리지 않습니다.",
  "",
  "## 검수 대기 시간",
  "분류 단계에서 유형을 먼저 고르면 확인 항목과 커멘트를 한 화면에서 읽게 되어, 검수 대기에 머무는 시간이 줄어듭니다.",
  "",
  "## 다음 작업",
  "폴더 문서 승격 뒤 문서 목록에서 바로 읽을 수 있는지 확인합니다.",
].join("\n");

export const DOCUMENTS: Record<string, MarkdownDocument> = {
  [DESIGN_DOCUMENT_ID]: {
    id: DESIGN_DOCUMENT_ID,
    title: PROMOTED_DOCUMENT_TITLE,
    body: DESIGN_DOCUMENT_BODY,
    version: 1,
    createdAt: "2026-11-19T03:20:00Z",
    updatedAt: "2026-11-19T03:20:00Z",
  },
  [PROMOTED_DOCUMENT_ID]: {
    id: PROMOTED_DOCUMENT_ID,
    title: PROMOTED_DOCUMENT_TITLE,
    body: DESIGN_DOCUMENT_BODY,
    version: 1,
    createdAt: "2026-11-19T12:30:00Z",
    updatedAt: "2026-11-19T12:30:00Z",
  },
};

export interface OverviewChatTurn {
  id: string;
  role: "assistant" | "user";
  text: string;
  time: string;
}

export const INITIAL_PAS_CHAT: OverviewChatTurn[] = [
  {
    id: "pas-chat-1",
    role: "assistant",
    text: "검수 대기 안건 다섯 건을 올렸습니다. 말풍선에서 보고 창을 열면 한 화면에서 마무리할 수 있습니다.",
    time: "09:10",
  },
  {
    id: "pas-chat-2",
    role: "user",
    text: "카드마다 탭을 열지 않아도 되게 해 주세요.",
    time: "09:14",
  },
  {
    id: "pas-chat-3",
    role: "assistant",
    text: "원 요청, 전체 커멘트, 담당 세션 대화를 나란히 폈습니다. 아래 도크에서 지시와 처분을 함께 하시면 됩니다.",
    time: "09:16",
  },
];

export function isPendingCard(card: Pick<OverviewScenario, "status" | "blockedKind">) {
  return card.status === "review" || (card.status === "blocked" && card.blockedKind === "question");
}

export function overviewStatusLabel(card: Pick<OverviewScenario, "status" | "blockedKind">) {
  if (card.status === "blocked") return card.blockedKind === "question" ? "답변 대기" : "막힘";
  return {
    todo: "드래프트",
    queued: "대기",
    running: "실행 중",
    awaiting_verification: "검증 대기",
    review: "검수 대기",
    on_hold: "보류",
    done: "완료",
    cancelled: "취소",
  }[card.status];
}

export function overviewCardRow(card: OverviewScenario): CardRow {
  return {
    id: card.id,
    number: card.number,
    folderId: "folder-soulstream",
    title: card.title,
    request: card.request,
    brief: "",
    attachments: [],
    status: card.status,
    blockedKind: card.blockedKind,
    blockedDetail: null,
    positionKey: `overview-${card.number}`,
    queuePositionKey: null,
    assigneeKind: "agent",
    assigneeAgentId: card.agent,
    assigneeUserId: null,
    assigneeSessionId: null,
    nodeId: "eiaserinnys",
    modelPreset: "Sol",
    version: 1,
    archived: false,
    createdAt: MOCK_NOW,
    updatedAt: MOCK_NOW,
    latestActivity: null,
    items: card.items,
  };
}
