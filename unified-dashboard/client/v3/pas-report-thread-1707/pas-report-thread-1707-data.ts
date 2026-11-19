import type { CardRow, CardStatus } from "@seosoyoung/soul-ui/cards/card-types";

/** 시안 C의 다섯 안건이 쓰는 고정 시나리오. 화면 상태는 이 값을 복제해 쓴다. */

export type AgentId = "roselin" | "keke" | "seosoyoung" | "selaphiel";

export const AGENT_NAMES: Record<AgentId, string> = {
  roselin: "로젤린",
  keke: "키키",
  seosoyoung: "서소영",
  selaphiel: "세라피엘",
};

export const agentPortraitUrl = (agent: AgentId) => `/api/nodes/eiaserinnys/agents/${agent}/portrait`;

export type AgendaKind = "question" | "request" | "design" | "ui" | "observation";

export const AGENDA_KIND_LABEL: Record<AgendaKind, string> = {
  question: "질문",
  request: "부탁",
  design: "설계서",
  ui: "UI 구현",
  observation: "관찰",
};

export type AgendaStatus = Extract<CardStatus, "review" | "running" | "awaiting_verification" | "done">;

export const AGENDA_STATUS_LABEL: Record<AgendaStatus, string> = {
  review: "검수 대기",
  running: "실행 중",
  awaiting_verification: "검증 대기",
  done: "완료",
};

export type DispositionId = "approve" | "keep" | "recheck3" | "evening" | "done";

export type CheckItem = { id: string; label: string; done: boolean };

export type EvidenceKind = "range" | "version" | "flow" | "slide" | "days";

export type Evidence = { kind: EvidenceKind; label: string; caption: string };

export type SessionTurn = { id: string; role: "user" | "assistant"; text: string };

export type ThreadEvent =
  | { id: string; kind: "request"; at: string; text: string }
  | { id: string; kind: "session"; at: string; agent: AgentId; summary: string; turns: SessionTurn[] }
  | { id: string; kind: "comment"; at: string; author: "user" | "agent"; agent?: AgentId; text: string }
  | { id: string; kind: "result"; at: string; checks: CheckItem[]; evidence: Evidence; documentId?: string; caveat?: string };

export type QuestionSeed = {
  id: string;
  title: string;
  background: string;
  kind: "choice" | "request";
  options: { label: string; description: string | null; recommended: boolean }[];
};

export type DecisionStamp = { id: DispositionId; label: string };

export type Agenda = {
  id: string;
  number: number;
  kind: AgendaKind;
  title: string;
  requestText: string;
  summary: string;
  agent: AgentId;
  status: AgendaStatus;
  events: ThreadEvent[];
  question?: QuestionSeed;
  primary: DecisionStamp | null;
  secondary: DecisionStamp | null;
  documentId?: string;
};

export const INITIAL_HOLD_COUNT = 18;

const documentId = "doc-turn-interaction-v3";

export const AGENDA_FIXTURES: readonly Agenda[] = [
  {
    id: "card-1680",
    number: 1680,
    kind: "question",
    title: "완료 목록 기간 칩의 기본 범위",
    requestText: "완료 목록을 열 때 기간 칩이 처음 보여 줄 범위를 정해 주세요. 지금은 최근 7일이 기본입니다.",
    summary: "기간 칩의 첫 범위를 최근 7일로 둘지, 14일이나 전체로 넓힐지 정해 주세요.",
    agent: "roselin",
    status: "review",
    primary: null,
    secondary: null,
    question: {
      id: "question-1680",
      title: "완료 목록 기간 칩 기본 범위",
      background: "완료 목록은 최근 7일을 기본으로 엽니다. 최근 30일 완료 142건을 세어 보니 7일 안에 62%, 14일 안에 89%가 끝났습니다. 첫 화면의 기본 범위를 어디로 둘까요?",
      kind: "choice",
      options: [
        { label: "최근 7일 유지", description: "지금처럼 최근 일주일만 먼저 보여 줍니다.", recommended: true },
        { label: "최근 14일", description: "완료의 89%가 첫 화면에 들어옵니다.", recommended: false },
        { label: "전체 기간", description: "오래된 완료까지 처음부터 모두 보여 줍니다.", recommended: false },
      ],
    },
    events: [
      { id: "1680-request", kind: "request", at: "11월 18일 21:40", text: "완료 목록을 열 때 기간 칩이 처음 보여 줄 범위를 정해 주세요. 지금은 최근 7일이 기본입니다. 최근 30일 완료 기록을 세어 보고 판단할 근거를 함께 주세요." },
      {
        id: "1680-session", kind: "session", at: "11월 18일 22:05", agent: "roselin",
        summary: "최근 30일 완료 142건을 세었습니다. 7일 안에 62%, 14일 안에 89%가 끝났습니다.",
        turns: [
          { id: "1680-turn-1", role: "assistant", text: "완료 기록 30일치를 모아 기간별로 나눴습니다. 7일 88건, 14일 126건, 30일 142건입니다." },
          { id: "1680-turn-2", role: "assistant", text: "7일 기본은 확인 주기와 맞고, 14일은 첫 화면 항목이 세 배로 늘어납니다. 선택지 세 개로 정리하겠습니다." },
          { id: "1680-turn-3", role: "user", text: "선택지 설명에 분포를 짧게 붙여 주세요." },
        ],
      },
      {
        id: "1680-result", kind: "result", at: "11월 19일 09:10",
        checks: [
          { id: "1680-check-1", label: "최근 30일 완료 142건을 기간별로 셌다", done: true },
          { id: "1680-check-2", label: "선택지마다 첫 화면의 변화를 적었다", done: true },
        ],
        evidence: { kind: "range", label: "완료 분포 도표", caption: "최근 30일 완료 142건 가운데 7일 62%, 14일 89%, 30일 100%." },
      },
    ],
  },
  {
    id: "card-1512",
    number: 1512,
    kind: "request",
    title: "집 PC kaleidoscope 앱 수동 업데이트",
    requestText: "집 PC의 kaleidoscope 사용량 앱을 0.9.4에서 0.9.7로 올려 주세요. 시간이 날 때 하면 됩니다.",
    summary: "집 PC 앱을 0.9.7로 올렸습니다. 설치본과 동기화 상태를 확인해 주세요.",
    agent: "keke",
    status: "review",
    primary: { id: "done", label: "했어" },
    secondary: { id: "evening", label: "저녁에 다시 보기" },
    question: {
      id: "question-1512",
      title: "집 PC 앱 수동 업데이트",
      background: "집 PC의 kaleidoscope 사용량 앱이 0.9.4입니다. 0.9.7 설치 파일을 내려받았고, 업데이트 뒤 사용량 동기화는 그대로 동작합니다. 오늘 안에 설치를 마치면 됩니다.",
      kind: "request",
      options: [],
    },
    events: [
      { id: "1512-request", kind: "request", at: "11월 18일 19:05", text: "집 PC의 kaleidoscope 사용량 앱이 예전 버전입니다. 0.9.4에서 0.9.7로 수동 업데이트해 주세요. 급하지 않으니 시간이 날 때 하면 됩니다." },
      {
        id: "1512-session", kind: "session", at: "11월 18일 19:20", agent: "keke",
        summary: "집 PC 설치본 0.9.4와 최신 0.9.7을 확인했습니다. 설치 파일을 내려받아 두었고 사용량 동기화는 정상입니다.",
        turns: [
          { id: "1512-turn-1", role: "assistant", text: "집 PC 설치본은 0.9.4, 저장소의 최신은 0.9.7입니다. 서명과 용량을 확인하고 설치 파일을 내려받았습니다." },
          { id: "1512-turn-2", role: "assistant", text: "사용량 동기화와 아침 보고는 0.9.4에서도 정상입니다. 업데이트는 집 PC 앞에 있을 때 실행하면 됩니다." },
        ],
      },
      {
        id: "1512-result", kind: "result", at: "11월 18일 19:35",
        checks: [
          { id: "1512-check-1", label: "0.9.7 설치 파일의 서명과 용량을 확인했다", done: true },
          { id: "1512-check-2", label: "현재 사용량 동기화가 정상임을 확인했다", done: true },
        ],
        evidence: { kind: "version", label: "버전 비교 도표", caption: "0.9.4와 0.9.7의 차이. 설치 파일 준비 완료, 동기화 정상." },
        caveat: "설치는 집 PC에서 직접 눌러야 합니다. 설치 뒤 앱을 한 번 열어 버전을 확인해 주세요.",
      },
    ],
  },
  {
    id: "card-1387",
    number: 1387,
    kind: "design",
    title: "턴 안 상호작용 3단계 도입 설계안",
    requestText: "턴 안 상호작용을 접수, 분류, 실행 세 단계로 나누는 설계안을 검토해 주세요. 구현 전에 방향만 정하면 됩니다.",
    summary: "접수, 분류, 실행 세 단계로 나누는 설계 문서 한 편을 정리했습니다.",
    agent: "seosoyoung",
    status: "review",
    primary: { id: "keep", label: "참고 보관 후 완료" },
    secondary: null,
    documentId,
    events: [
      { id: "1387-request", kind: "request", at: "11월 18일 16:22", text: "턴 안 상호작용을 접수, 분류, 실행 세 단계로 나누는 설계안을 검토해 주세요. 구현은 다음 카드에서 시작하고, 지금은 방향만 정하면 됩니다." },
      {
        id: "1387-session", kind: "session", at: "11월 18일 17:40", agent: "seosoyoung",
        summary: "기존 PAS 보고, 카드 확인 항목과 겹치는 부분을 정리해 설계 문서 한 편으로 묶었습니다.",
        turns: [
          { id: "1387-turn-1", role: "assistant", text: "접수는 요청을 카드로 만들고, 분류는 담당과 검수 방식을 정하며, 실행은 작업 세션에 넘기는 흐름으로 잡았습니다." },
          { id: "1387-turn-2", role: "assistant", text: "기존 보고 창과 겹치는 결재 상자는 그대로 두고, 단계 이름만 맞추는 쪽이 변경이 작습니다." },
        ],
      },
      {
        id: "1387-result", kind: "result", at: "11월 18일 18:10",
        checks: [
          { id: "1387-check-1", label: "세 단계의 입구와 출구를 문서에 적었다", done: true },
          { id: "1387-check-2", label: "기존 PAS 보고와 겹치는 부분을 표시했다", done: true },
        ],
        evidence: { kind: "flow", label: "세 단계 흐름 도식", caption: "접수에서 분류로, 분류에서 실행으로 넘어가는 한 줄기 흐름." },
        documentId,
        caveat: "구현은 다음 카드에서 시작합니다. 이 설계는 참고 보관으로 남겨 두면 나중에 다시 읽을 수 있습니다.",
      },
    ],
  },
  {
    id: "card-1408",
    number: 1408,
    kind: "ui",
    title: "슬라이드 편집 장 순서 변경과 줄간격 보정",
    requestText: "슬라이드 편집에서 장 순서를 바꾸는 동작과 줄간격을 발행 화면과 같게 맞춰 주세요.",
    summary: "장 순서 변경과 줄간격 보정을 마쳤습니다. 세라피엘 검수를 통과했습니다.",
    agent: "selaphiel",
    status: "review",
    primary: { id: "approve", label: "승인 완료" },
    secondary: null,
    events: [
      { id: "1408-request", kind: "request", at: "11월 18일 14:10", text: "슬라이드 편집에서 장 순서를 바꾸는 동작과 줄간격을 발행 화면과 같게 맞춰 주세요. 편집 화면과 발행 화면을 오갈 때 같은 인상을 주어야 합니다." },
      {
        id: "1408-session", kind: "session", at: "11월 18일 15:30", agent: "roselin",
        summary: "장 유형 순서 변경을 구현했고 저장까지 이어지는 것을 확인했습니다. 줄간격은 발행 화면 값을 그대로 가져왔습니다.",
        turns: [
          { id: "1408-turn-1", role: "assistant", text: "장 순서를 바꾸면 편집 상태와 저장 요청의 순서가 함께 바뀝니다. 되돌리기도 같은 순서를 씁니다." },
          { id: "1408-turn-2", role: "assistant", text: "줄간격은 발행 화면의 본문 줄 높이와 같은 값을 썼습니다. 첫 화면에서 두 화면을 나란히 확인했습니다." },
        ],
      },
      { id: "1408-comment-1", kind: "comment", at: "11월 18일 16:05", author: "user", text: "2번 항목, 장 사이 여백이 발행 화면보다 좁습니다. 그 부분만 다시 봐 주세요." },
      {
        id: "1408-session-2", kind: "session", at: "11월 18일 17:20", agent: "roselin",
        summary: "장 사이 여백을 발행 화면과 같은 값으로 맞췄고, 세라피엘이 통과했습니다.",
        turns: [
          { id: "1408-turn-3", role: "assistant", text: "장 사이 여백을 발행 화면과 같은 값으로 올렸습니다. 편집 화면과 발행 화면의 간격이 같아졌습니다." },
          { id: "1408-turn-4", role: "user", text: "세라피엘 검수를 다시 받아 주세요." },
          { id: "1408-turn-5", role: "assistant", text: "세라피엘 검수에서 통과했습니다. 장 순서, 여백, 저장 왕복 세 가지를 확인했습니다." },
        ],
      },
      { id: "1408-comment-2", kind: "comment", at: "11월 18일 17:25", author: "agent", agent: "selaphiel", text: "검수에서 통과했습니다. 장 순서, 장 사이 여백, 저장 왕복 세 가지를 다시 확인했습니다." },
      {
        id: "1408-result", kind: "result", at: "11월 19일 08:50",
        checks: [
          { id: "1408-check-1", label: "장 순서를 바꾸면 저장 순서도 함께 바뀐다", done: true },
          { id: "1408-check-2", label: "장 사이 여백이 발행 화면과 같다", done: true },
          { id: "1408-check-3", label: "세라피엘 검수를 통과했다", done: true },
        ],
        evidence: { kind: "slide", label: "편집 화면 비교 도표", caption: "장 순서를 바꾸기 전과 뒤, 발행 화면과 같은 여백." },
      },
    ],
  },
  {
    id: "card-1112",
    number: 1112,
    kind: "observation",
    title: "할 일 앱 이전과 아침 예약 알림 연동",
    requestText: "할 일 앱을 이전한 뒤에도 아침 예약 알림이 오는지 사흘 동안 지켜봐 주세요.",
    summary: "이전 뒤 할 일 12건이 그대로 보이고, 사흘째 아침 7시 알림까지 도착했습니다.",
    agent: "keke",
    status: "review",
    primary: { id: "recheck3", label: "사흘 뒤 재확인" },
    secondary: null,
    events: [
      { id: "1112-request", kind: "request", at: "11월 17일 22:48", text: "할 일 앱을 이전한 뒤에도 아침 예약 알림이 오는지 사흘 동안 지켜봐 주세요. 놓친 알림이 있으면 날짜와 시각을 적어 주세요." },
      {
        id: "1112-session", kind: "session", at: "11월 17일 23:10", agent: "keke",
        summary: "이전 뒤 할 일 12건이 그대로 보입니다. 아침 7시 예약 알림을 사흘 기록하기로 했습니다.",
        turns: [
          { id: "1112-turn-1", role: "assistant", text: "이전한 계정에서 할 일 12건과 예약 시각을 확인했습니다. 누락은 아직 없습니다." },
          { id: "1112-turn-2", role: "assistant", text: "사흘 동안 아침 7시 알림의 도착 시각을 기록하겠습니다. 하루라도 빠지면 바로 알려 드립니다." },
        ],
      },
      { id: "1112-comment-1", kind: "comment", at: "11월 19일 07:10", author: "agent", agent: "keke", text: "사흘째 아침 알림까지 도착했습니다. 세 날의 도착 시각을 결과에 붙였습니다." },
      {
        id: "1112-result", kind: "result", at: "11월 19일 07:20",
        checks: [
          { id: "1112-check-1", label: "이전 뒤 할 일 12건이 그대로 보인다", done: true },
          { id: "1112-check-2", label: "사흘 아침 7시 알림이 모두 도착했다", done: true },
        ],
        evidence: { kind: "days", label: "사흘 알림 기록표", caption: "11월 17일, 18일, 19일 아침 7시 알림 도착 기록." },
        caveat: "사흘 기록이 끝났습니다. 한 번 더 지켜볼지 지금 마무리할지 정해 주세요.",
      },
    ],
  },
];

export function cloneAgendas(): Agenda[] {
  return AGENDA_FIXTURES.map((agenda) => ({ ...agenda, events: [...agenda.events] }));
}

export const DOCUMENT_BODIES: Record<string, { id: string; title: string; body: string; version: number }> = {
  [documentId]: {
    id: documentId,
    title: "턴 안 상호작용 3단계 도입 설계안",
    version: 3,
    body: [
      "## 목표",
      "턴 안에서 일어나는 요청 접수, 분류, 실행을 세 단계로 나누고, 각 단계의 입구와 출구를 한 곳에서 읽게 한다.",
      "",
      "## 1단계, 접수",
      "디렉터의 요청을 카드 한 장으로 만든다. 요청 문장과 완료 조건을 같은 화면에 둔다.",
      "",
      "## 2단계, 분류",
      "담당 에이전트와 검수 방식을 정한다. 질문, 부탁, 설계서, 구현, 관찰 가운데 하나로 표시한다.",
      "",
      "## 3단계, 실행",
      "작업 세션에 넘기고, 결과는 확인 항목과 대표 증거로 돌려받는다. 결재 상자는 기존 PAS 보고 창을 그대로 쓴다.",
      "",
      "## 기존 PAS 보고와의 관계",
      "- 보고 창의 결재 상자는 바꾸지 않는다.",
      "- 단계 이름만 카드 종류와 맞춘다.",
      "- 보류함 수는 건드리지 않는다.",
    ].join("\n"),
  },
};

export function chatMessageText(agenda: Agenda, disposition: DispositionId) {
  const label = dispositionLabel(disposition);
  if (disposition === "keep") return `#${agenda.number} ${agenda.title}을 참고 보관으로 남기고 완료했습니다. 문서는 보관함에서 다시 읽을 수 있습니다.`;
  if (disposition === "recheck3") return `#${agenda.number} ${agenda.title}을 사흘 뒤 재확인으로 넘겼습니다. 보류함은 18개 그대로입니다.`;
  if (disposition === "evening") return `#${agenda.number} ${agenda.title}을 오늘 저녁에 다시 보기로 넘겼습니다.`;
  return `#${agenda.number} ${agenda.title}을 ${label}로 처분했습니다.`;
}

export function dispositionLabel(disposition: DispositionId) {
  return {
    approve: "승인 완료",
    keep: "참고 보관 후 완료",
    recheck3: "사흘 뒤 재확인",
    evening: "저녁에 다시 보기",
    done: "했어",
  }[disposition];
}

const CARD_STATUS: Record<AgendaStatus, CardStatus> = {
  review: "review",
  running: "running",
  awaiting_verification: "awaiting_verification",
  done: "done",
};

export function taskCardsFor(agendas: readonly Agenda[]): CardRow[] {
  return agendas.map((agenda) => ({
    id: agenda.id,
    number: agenda.number,
    folderId: "pas-report-1707",
    title: agenda.title,
    request: agenda.requestText,
    brief: agenda.summary,
    attachments: [],
    status: CARD_STATUS[agenda.status],
    blockedKind: null,
    blockedDetail: null,
    assigneeKind: "agent",
    assigneeAgentId: agenda.agent,
    assigneeUserId: null,
    assigneeSessionId: null,
    nodeId: "eiaserinnys",
    modelPreset: "roselin[deepseek-flash-4.1]",
    version: 1,
    archived: false,
    positionKey: `p${agenda.number}`,
    queuePositionKey: null,
    createdAt: "2026-11-18T09:00:00.000Z",
    updatedAt: "2026-11-19T00:00:00.000Z",
    now: {
      text: agenda.summary,
      turn: "agent",
      ask: null,
      updatedAt: "2026-11-19T00:00:00.000Z",
      sessionId: null,
    },
  }));
}

export const INITIAL_CHAT: readonly { id: string; role: "user" | "assistant"; content: string; timestamp: number }[] = [
  { id: "chat-1", role: "assistant", content: "오늘 결재할 안건 다섯 건을 보고 창에 모았습니다. 보고 창을 열면 원 요청부터 결과까지 한 줄기로 읽고, 스레드 끝에서 바로 처분할 수 있습니다.", timestamp: Date.parse("2026-11-19T09:05:00+09:00") },
  { id: "chat-2", role: "user", content: "#1408 슬라이드 편집은 장 순서부터 볼게요.", timestamp: Date.parse("2026-11-19T09:18:00+09:00") },
  { id: "chat-3", role: "assistant", content: "#1408 장 순서와 줄간격을 같은 흐름에 묶었습니다. 확인 항목에서 바로 지시할 수 있습니다.", timestamp: Date.parse("2026-11-19T09:19:00+09:00") },
];
