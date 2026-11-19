// 카드 #1707 시안 A. PAS 강화형 결재 브리핑 갑지의 시나리오 데이터.
// 다섯 안건은 모두 가상이며 민감 정보를 담지 않는다. 화면 문구는 결재 화면의
// 말투를 따르고, 숫자는 분포와 비교를 읽는 데 필요한 만큼만 둔다.
import type { CardCheckItem, CardRow, CardStatus } from "@seosoyoung/soul-ui/cards/card-types";
import type { CardQuestionView } from "../CardQuestionBlock";

export type AgentId = "seosoyoung" | "roselin" | "keke" | "selaphiel";
export type AgendaKind = "question" | "favor" | "design" | "ui" | "observation";
export type StampOutcome = "done" | "reference" | "running" | "awaiting";

export interface AgendaComment {
  id: string;
  author: "user" | "agent";
  name: string;
  at: string;
  body: string;
}

export interface AgendaSpoken {
  agent: AgentId;
  text: string;
}

export interface AgendaBar {
  label: string;
  value: number;
}

export interface AgendaCompare {
  title: string;
  columns: [string, string];
  rows: { label: string; before: string; after: string }[];
  note: string;
}

export interface AgendaTimeline {
  title: string;
  columns: [string, string, string];
  rows: [string, string, string][];
  note: string;
}

export interface AgendaStamp {
  id: string;
  label: string;
  primary?: boolean;
  outcome: StampOutcome;
  taskStatus: CardStatus;
  chat: [string, string];
}

export interface Agenda {
  key: string;
  number: number;
  kind: AgendaKind;
  kindLabel: string;
  statusLabel: string;
  statusTone: "question" | "review" | "running" | "done";
  title: string;
  request: string;
  assignee: AgentId;
  assigneeName: string;
  summary: [string, string];
  comments: AgendaComment[];
  spoken: AgendaSpoken[];
  hint: string;
  caveat?: string;
  bars?: { caption: string; rows: AgendaBar[]; note: string };
  compare?: AgendaCompare;
  steps?: { n: number; title: string; body: string }[];
  timeline?: AgendaTimeline;
  checks?: CardCheckItem[];
  question?: CardQuestionView;
  docId?: string;
  docLabel?: string;
  stamps: AgendaStamp[];
}

export const AGENT_NAMES: Record<AgentId, string> = {
  seosoyoung: "서소영",
  roselin: "로젤린",
  keke: "키키",
  selaphiel: "세라피엘",
};

export const HOLD_COUNT = 18;

export const PAS_SESSION_ID = "mockup-pas-1707-briefing";

function reportedCheck(id: number, title: string, result: string, caveat: string | null = null): CardCheckItem {
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
    createdAt: "2026-11-19T08:10:00Z",
    reportedAt: "2026-11-19T08:10:00Z",
    display: "reported",
  };
}

export const AGENDAS: readonly Agenda[] = [
  {
    key: "1680",
    number: 1680,
    kind: "question",
    kindLabel: "질문",
    statusLabel: "질문",
    statusTone: "question",
    title: "완료 목록의 기간 칩 기본값을 정해 주세요",
    request: "완료 목록을 열 때 기본으로 보일 기간을 최근 7일로 둘지 정해 주세요.",
    assignee: "roselin",
    assigneeName: AGENT_NAMES.roselin,
    summary: [
      "지금은 기간 칩이 비어 있어 목록을 열 때마다 전체 기간이 먼저 보입니다.",
      "최근 30일 완료 142건 가운데 41건이 최근 7일에 있어, 최근 7일을 기본으로 두는 안을 권합니다.",
    ],
    comments: [
      { id: "c-1680-1", author: "user", name: "디렉터", at: "11.18 16:20", body: "완료 목록을 자주 열어. 기본 기간이 있으면 좋겠어." },
      { id: "c-1680-2", author: "agent", name: "로젤린", at: "11.19 09:12", body: "기간 칩 기본값 후보를 최근 7일, 최근 14일, 전체 기간으로 정리했습니다." },
    ],
    spoken: [
      { agent: "roselin", text: "최근 30일 완료 142건의 날짜 분포를 세어 봤습니다." },
      { agent: "roselin", text: "최근 7일이 41건으로 가장 많고, 최근 14일이 79건입니다." },
    ],
    hint: "선택지를 누르면 바로 처분됩니다. 다르게 답하려면 아래에 적어 주세요.",
    bars: {
      caption: "최근 30일 완료 142건의 기간별 분포",
      rows: [
        { label: "이번 주", value: 41 },
        { label: "지난주", value: 38 },
        { label: "2주 전", value: 35 },
        { label: "3주 전", value: 28 },
      ],
      note: "기간 칩 후보를 정하려고 최근 30일 완료 건을 주별로 나눈 값입니다.",
    },
    question: {
      id: "question-1680",
      title: null,
      background: "아래 선택지에서 완료 목록을 열 때 기본으로 둘 기간을 골라 주세요.",
      kind: "choice",
      options: [
        { label: "최근 7일", description: "가장 최근 흐름만 먼저 봅니다.", recommended: true },
        { label: "최근 14일", description: "지난주까지 함께 봅니다.", recommended: false },
        { label: "전체 기간", description: "오래된 완료 건까지 모두 봅니다.", recommended: false },
      ],
      attachments: [],
      thread: [],
      open: true,
      selectedOption: null,
      answer: null,
      revisedAt: null,
      awaitingAgent: false,
    },
    stamps: [
      {
        id: "ask",
        label: "되묻기",
        outcome: "running",
        taskStatus: "running",
        chat: [
          "최근 7일을 고른 이유를 먼저 알려 주세요.",
          "최근 30일 완료 142건 중 최근 7일이 41건으로 가장 많습니다. 그 기준으로 다시 확인해 보겠습니다.",
        ],
      },
    ],
  },
  {
    key: "1512",
    number: 1512,
    kind: "favor",
    kindLabel: "부탁",
    statusLabel: "부탁",
    statusTone: "review",
    title: "집 PC kaleidoscope를 0.9.7로 올려 주세요",
    request: "집 PC의 kaleidoscope를 0.9.4에서 0.9.7로 수동 업데이트해 주세요.",
    assignee: "keke",
    assigneeName: AGENT_NAMES.keke,
    summary: [
      "자동 업데이트가 꺼져 있어 0.9.4가 남아 있습니다.",
      "0.9.7은 첫 실행 시간이 줄고 동기화 방식이 바뀌어, 한 번 직접 올린 뒤 확인이 필요합니다.",
    ],
    comments: [
      { id: "c-1512-1", author: "agent", name: "키키", at: "11.18 21:40", body: "집 PC만 0.9.4입니다. 설치 파일과 확인 순서를 적어 두었습니다." },
    ],
    spoken: [
      { agent: "keke", text: "설치 파일은 0.9.7로 준비해 두었습니다." },
      { agent: "keke", text: "올린 뒤 앱 버전과 동기화 표시를 보면 됩니다." },
    ],
    hint: "직접 올렸으면 했어를 누르세요. 저녁에 다시 보려면 오른쪽 단추를 누르세요.",
    compare: {
      title: "0.9.4와 0.9.7 비교",
      columns: ["0.9.4", "0.9.7"],
      rows: [
        { label: "앱 버전", before: "0.9.4", after: "0.9.7" },
        { label: "동기화 방식", before: "30초마다 확인", after: "바뀔 때 바로 받기" },
        { label: "첫 실행 시간", before: "6.2초", after: "2.8초" },
      ],
      note: "설치 후 첫 실행에서 잰 값입니다.",
    },
    steps: [
      { n: 1, title: "새 설치 파일 내려받기", body: "받은 파일을 실행하고 기존 폴더 위에 설치합니다." },
      { n: 2, title: "버전과 동기화 확인", body: "앱을 열어 버전이 0.9.7인지, 동기화 표시가 연결됨인지 봅니다." },
    ],
    checks: [
      reportedCheck(1, "앱 버전이 0.9.7로 보입니까?", "앱 정보 화면에서 0.9.7을 확인했습니다."),
      reportedCheck(2, "동기화 표시가 연결됨으로 보입니까?", "실행 3초 뒤 연결됨으로 바뀌었습니다."),
    ],
    stamps: [
      {
        id: "did",
        label: "했어",
        primary: true,
        outcome: "running",
        taskStatus: "running",
        chat: [
          "수동 업데이트를 마쳤습니다.",
          "버전과 동기화 상태를 확인하겠습니다. 문제가 보이면 바로 알리겠습니다.",
        ],
      },
      {
        id: "evening",
        label: "저녁에 다시 보기",
        outcome: "awaiting",
        taskStatus: "awaiting_verification",
        chat: [
          "저녁에 다시 보겠습니다.",
          "저녁 7시에 버전과 동기화 상태를 확인하겠습니다.",
        ],
      },
    ],
  },
  {
    key: "1387",
    number: 1387,
    kind: "design",
    kindLabel: "설계서",
    statusLabel: "검수",
    statusTone: "review",
    title: "턴 안 상호작용 3단계 도입 설계안",
    request: "턴이 끝나기 전에도 확인과 선택을 주고받는 3단계 설계안을 검토해 주세요.",
    assignee: "seosoyoung",
    assigneeName: AGENT_NAMES.seosoyoung,
    summary: [
      "턴이 끝나야만 답을 받는 지금 방식은 확인이 늦고, 같은 내용을 다시 주고받게 만듭니다.",
      "접수, 분류, 실행의 세 단계로 나누고, 확인이 필요한 자리에서만 멈추는 설계안입니다.",
    ],
    comments: [
      { id: "c-1387-1", author: "user", name: "디렉터", at: "11.17 10:05", body: "턴 중간에 확인할 수 있으면 좋겠어. 어디서 멈출지가 중요해." },
      { id: "c-1387-2", author: "agent", name: "서소영", at: "11.18 18:30", body: "멈추는 자리를 확인, 선택, 승인 세 가지로 줄이고 나머지는 이어서 처리하도록 설계했습니다." },
    ],
    spoken: [
      { agent: "seosoyoung", text: "접수와 분류는 대화를 끊지 않고 처리합니다." },
      { agent: "seosoyoung", text: "실행 전 승인이 필요한 경우에만 잠시 멈춥니다." },
    ],
    hint: "문서를 열어 보고, 참고 문서로 남길지 일반 완료할지 고르세요.",
    steps: [
      { n: 1, title: "접수", body: "요청을 받으면 필요한 확인 항목을 먼저 뽑습니다." },
      { n: 2, title: "분류", body: "바로 처리할 일과 확인이 필요한 일을 나눕니다." },
      { n: 3, title: "실행", body: "확인이 필요한 자리에서만 멈추고, 확인 뒤 이어서 처리합니다." },
    ],
    docId: "pas-1707-turn-design",
    docLabel: "설계안 문서 열기",
    stamps: [
      {
        id: "reference",
        label: "참고 문서로 남기고 완료",
        primary: true,
        outcome: "reference",
        taskStatus: "done",
        chat: [
          "설계안은 참고 문서로 남기고 완료합니다.",
          "문서 주소를 기록해 두었습니다. 다음 설계에서 다시 꺼내 보겠습니다.",
        ],
      },
      {
        id: "plain",
        label: "일반 완료",
        outcome: "done",
        taskStatus: "done",
        chat: [
          "설계안 검토를 마쳤습니다.",
          "남은 작업은 없습니다.",
        ],
      },
    ],
  },
  {
    key: "1408",
    number: 1408,
    kind: "ui",
    kindLabel: "화면 구현",
    statusLabel: "검수",
    statusTone: "review",
    title: "슬라이드 편집 장 순서 변경과 줄간격 보정",
    request: "장 순서를 끌어 옮기는 동작과 줄간격 보정을 화면에서 확인해 주세요.",
    assignee: "selaphiel",
    assigneeName: AGENT_NAMES.selaphiel,
    summary: [
      "장 순서를 옮기면 저장 뒤에 순서가 되돌아가던 문제를 고쳤습니다.",
      "1차 검수에서 지적한 줄간격 세 곳을 다시 맞추고 전후 값을 함께 적었습니다.",
    ],
    comments: [
      { id: "c-1408-1", author: "user", name: "디렉터", at: "11.18 14:10", body: "옮긴 장이 저장 뒤에 돌아가면 안 돼. 줄간격도 다시 봐 줘." },
      { id: "c-1408-2", author: "agent", name: "세라피엘", at: "11.18 19:02", body: "순서 저장 경로와 줄간격 세 곳을 고쳤습니다. 다시 확인 부탁드립니다." },
      { id: "c-1408-3", author: "agent", name: "세라피엘", at: "11.19 08:40", body: "1차 검수에서 지적한 소제목 줄간격도 1.6으로 맞췄습니다." },
    ],
    spoken: [
      { agent: "selaphiel", text: "장 순서는 저장 뒤에 다시 읽어 확인했습니다." },
      { agent: "selaphiel", text: "줄간격은 소제목, 본문, 목록 세 곳을 쟀습니다." },
    ],
    hint: "확인 항목을 누르면 확인으로 바뀝니다. 고칠 점이 있으면 항목 옆 단추를 누르세요.",
    caveat: "인쇄 미리보기의 쪽 나눔은 이번에 보지 못했습니다.",
    compare: {
      title: "줄간격 전후 비교",
      columns: ["고치기 전", "고친 뒤"],
      rows: [
        { label: "소제목", before: "1.45", after: "1.6" },
        { label: "본문", before: "1.55", after: "1.7" },
        { label: "목록", before: "1.45", after: "1.6" },
      ],
      note: "편집 화면에서 잰 값입니다.",
    },
    checks: [
      reportedCheck(1, "장 순서가 저장 뒤에도 그대로입니까?", "저장하고 다시 열어 순서를 확인했습니다."),
      reportedCheck(2, "줄간격이 다시 열어도 유지됩니까?", "앱을 다시 열어 세 곳을 확인했습니다."),
      reportedCheck(3, "좁은 폭에서도 겹침이 없습니까?", "360px 폭에서 겹침이 없었습니다."),
    ],
    stamps: [
      {
        id: "approve",
        label: "승인 완료",
        primary: true,
        outcome: "done",
        taskStatus: "done",
        chat: [
          "화면 구현을 승인했습니다.",
          "확인 항목 세 개를 모두 확인했습니다.",
        ],
      },
    ],
  },
  {
    key: "1112",
    number: 1112,
    kind: "observation",
    kindLabel: "관찰",
    statusLabel: "관찰",
    statusTone: "running",
    title: "할 일 앱 이전과 아침 예약 알림 연동",
    request: "할 일 앱을 옮긴 뒤 아침 7시 예약 알림이 그대로 오는지 지켜봐 주세요.",
    assignee: "keke",
    assigneeName: AGENT_NAMES.keke,
    summary: [
      "할 일 앱을 새 기기로 옮기고 예약 알림을 다시 걸었습니다.",
      "사흘 동안 아침 7시 알림이 모두 왔고, 알림을 누르면 앱이 열렸습니다.",
    ],
    comments: [
      { id: "c-1112-1", author: "agent", name: "키키", at: "11.16 20:15", body: "이전 뒤 예약 알림 세 개를 다시 걸었습니다. 사흘 동안 지켜보겠습니다." },
    ],
    spoken: [
      { agent: "keke", text: "첫날과 둘째 날은 7시 정각에 왔습니다." },
      { agent: "keke", text: "셋째 날도 7시에 왔고, 알림을 누르면 앱이 열렸습니다." },
    ],
    hint: "사흘 기록을 보고, 사흘 더 지켜볼지 지금 완료할지 고르세요.",
    caveat: "알림이 오지 않은 날의 기기 절전 기록은 보지 못했습니다.",
    timeline: {
      title: "아침 7시 알림 기록",
      columns: ["날짜", "보낸 시각", "결과"],
      rows: [
        ["11.17", "07:00", "도착, 누르면 앱 열림"],
        ["11.18", "07:00", "도착, 누르면 앱 열림"],
        ["11.19", "07:00", "도착, 누르면 앱 열림"],
      ],
      note: "기기 알림 기록에서 확인한 값입니다.",
    },
    checks: [
      reportedCheck(1, "사흘 모두 아침 7시에 알림이 왔습니까?", "세 날 모두 07:00에 도착했습니다."),
      reportedCheck(2, "알림을 누르면 할 일 앱이 열립니까?", "세 번 모두 앱이 열렸습니다."),
    ],
    stamps: [
      {
        id: "recheck",
        label: "사흘 뒤 재확인",
        primary: true,
        outcome: "awaiting",
        taskStatus: "awaiting_verification",
        chat: [
          "사흘 뒤 아침에 다시 확인해 주세요.",
          "11월 22일 아침 7시 알림까지 보고 다시 알리겠습니다.",
        ],
      },
      {
        id: "now",
        label: "지금 완료",
        outcome: "done",
        taskStatus: "done",
        chat: [
          "관찰 항목을 지금 완료합니다.",
          "세 날의 기록을 확인했으니 남은 확인은 없습니다.",
        ],
      },
    ],
  },
];

const CARD_BASE_STATUS: Record<string, CardStatus> = {
  "1680": "blocked",
  "1512": "blocked",
  "1387": "review",
  "1408": "review",
  "1112": "awaiting_verification",
};

export function baseTaskStatus(agenda: Agenda): CardStatus {
  return CARD_BASE_STATUS[agenda.key] ?? "todo";
}

export function taskCard(agenda: Agenda, status: CardStatus): CardRow {
  return {
    id: `mockup-card-${agenda.number}`,
    number: agenda.number,
    folderId: "mockup-pas-1707",
    title: agenda.title,
    request: agenda.request,
    brief: agenda.summary[0],
    attachments: [],
    status,
    blockedKind: agenda.kind === "question" ? "question" : agenda.kind === "favor" ? null : null,
    blockedDetail: agenda.kind === "question" ? "기간 칩 기본값" : null,
    positionKey: String(agenda.number),
    queuePositionKey: null,
    assigneeKind: "agent",
    assigneeAgentId: agenda.assignee,
    assigneeUserId: null,
    assigneeSessionId: null,
    nodeId: "eiaserinnys",
    modelPreset: null,
    version: 1,
    archived: false,
    createdAt: "2026-11-18T09:00:00Z",
    updatedAt: "2026-11-19T09:00:00Z",
    now: { text: agenda.request, turn: "agent", ask: null, updatedAt: "2026-11-19T09:00:00Z", sessionId: null },
  };
}

export interface SeedEvent {
  type: "user_message" | "assistant_message";
  text?: string;
  content?: string;
  user?: string;
}

export const SEED_EVENTS: readonly SeedEvent[] = [
  { type: "user_message", user: "User", text: "오늘 처리할 보고 다섯 건을 모아 두었어. 결재 갑지로 하나씩 보자." },
  { type: "assistant_message", content: "다섯 건을 한 장씩 묶었습니다. 질문 한 건, 부탁 한 건, 설계서 한 건, 화면 구현 한 건, 관찰 한 건입니다." },
  { type: "user_message", user: "User", text: "보고는 간결하게, 확인할 것만." },
  { type: "assistant_message", content: "확인 항목과 못 본 범위를 함께 적었습니다. 말풍선에서 보고 창을 열 수 있습니다." },
];

export const DESIGN_DOCUMENT = {
  id: "pas-1707-turn-design",
  title: "턴 안 상호작용 3단계 도입 설계안",
  body: `# 턴 안 상호작용 3단계 도입 설계안

## 왜 필요한가

지금은 턴이 끝나야만 답을 받을 수 있습니다. 확인이 필요한 순간에도 대화가 끝날 때까지 기다려야 하고, 같은 내용을 다음 턴에 다시 주고받게 됩니다.

## 1단계, 접수

요청을 받으면 필요한 확인 항목을 먼저 뽑습니다. 확인이 필요 없는 일은 이 단계에서 바로 다음으로 넘깁니다.

## 2단계, 분류

바로 처리할 일과 확인이 필요한 일을 나눕니다. 확인이 필요한 일에는 묻는 말과 선택지를 함께 붙입니다.

## 3단계, 실행

확인이 필요한 자리에서만 멈춥니다. 답을 받으면 같은 턴에서 이어서 처리하고, 남은 확인 항목이 있으면 다시 묻습니다.

## 멈추는 자리

- 확인: 결과가 바뀔 수 있는 선택
- 선택: 두 가지 이상의 길 가운데 하나를 고르는 일
- 승인: 되돌리기 어려운 실행 전

이 세 가지 밖에서는 멈추지 않습니다.

## 남은 확인

긴 작업에서 확인이 여러 번 이어질 때의 대기 시간은 아직 재지 못했습니다. 다음 설계에서 이어서 봅니다.`,
};
