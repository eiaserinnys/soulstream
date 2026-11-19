// 시안 C 의 견본 데이터. 회사 업무나 민감 정보 없이 화면 구조만 확인한다.
import type { CardColor } from "@seosoyoung/soul-ui/cards/card-types";

export type TriageTone = "question" | "review" | "running" | "blocked" | "done" | "queued" | "open";
export type TriageKind = "질문" | "검수 대기" | "부탁" | "관찰";
export type ItemState = "done" | "changed" | "todo" | "caveat";
export type BoardStatus = "todo" | "queued" | "running" | "blocked" | "review" | "on_hold" | "done";

export interface TriageItem {
  title: string;
  state: ItemState;
  result: string;
}

export interface TriageEvidence {
  id: string;
  label: string;
  note: string;
  variant: "wide" | "tall" | "code";
}

export interface SessionMessage {
  id: string;
  role: "agent" | "user";
  text: string;
  time: string;
}

export interface SessionTimelineStep {
  time: string;
  label: string;
  state: "done" | "doing";
}

export interface TriageSession {
  agentName: string;
  agentId: string;
  preset: string;
  node: string;
  emoji: string;
  status: "running" | "review" | "completed" | "offline";
  statusLabel: string;
  timeline: SessionTimelineStep[];
  messages: SessionMessage[];
}

export interface TriageCard {
  id: string;
  number: number;
  title: string;
  folderId: string;
  folderLabel: string;
  kind: TriageKind;
  tone: TriageTone;
  waited: string;
  request: string;
  scope: string;
  items: TriageItem[];
  evidence: TriageEvidence[];
  session: TriageSession;
  color: CardColor;
  boardStatus: BoardStatus;
}

export interface FolderEntry {
  id: string;
  name: string;
  count: number;
}

export interface BoardCard {
  id: string;
  number: number;
  title: string;
  folderId: string;
  folderLabel: string;
  status: BoardStatus;
  color: CardColor;
  assigneeName: string;
  assigneeEmoji: string;
  activity: string;
}

export const mockupFolders: readonly FolderEntry[] = [
  { id: "soulstream", name: "✨ 소울스트림", count: 21 },
  { id: "kaleidoscope", name: "🔮 kaleidoscope", count: 14 },
  { id: "pages", name: "🌐 Pages", count: 8 },
  { id: "workspace", name: "🪞 서소영 (워크스페이스)", count: 6 },
  { id: "system", name: "⚙️ 작업 배정", count: 5 },
  { id: "context", name: "🧠 인지와 컨텍스트", count: 4 },
  { id: "dashboard", name: "🖥️ 대시보드", count: 11 },
  { id: "misc", name: "📦 미분류", count: 9 },
];

export const MOCK_TODAY = "2026-11-19";

const roselin: TriageSession = {
  agentName: "로젤린",
  agentId: "roselin",
  preset: "deepseek-flash-4.1",
  node: "eiaserinnys",
  emoji: "🗡️",
  status: "running",
  statusLabel: "실행 중",
  timeline: [
    { time: "03:10", label: "요청 접수", state: "done" },
    { time: "03:11", label: "완료 목록 코드 확인", state: "done" },
    { time: "03:12", label: "기간 칩 선택지 비교", state: "done" },
    { time: "03:12", label: "질문 등록 후 대기", state: "doing" },
  ],
  messages: [
    { id: "m1680-1", role: "agent", text: "완료 목록 기간 칩의 기본 선택 범위를 정하려고 합니다. 최근 7일과 최근 30일 중 어느 쪽이 좋을까요?", time: "03:12" },
    { id: "m1680-2", role: "user", text: "요즘은 최근 7일을 자주 봅니다. 마지막에 고른 범위가 기억되면 더 좋고요.", time: "03:18" },
    { id: "m1680-3", role: "agent", text: "최근 7일을 기본으로 두고, 마지막에 고른 범위를 기기에 기억하는 안으로 정리했습니다. 이 방향으로 진행할까요?", time: "03:19" },
  ],
};

const kiki: TriageSession = {
  agentName: "키키",
  agentId: "kiki",
  preset: "claude-sonnet-4.5",
  node: "eias-linegames",
  emoji: "🐈",
  status: "review",
  statusLabel: "검수 대기",
  timeline: [
    { time: "02:40", label: "부탁 접수", state: "done" },
    { time: "02:41", label: "집 PC 앱스토어 목록 확인", state: "done" },
    { time: "02:44", label: "사용량 앱 업데이트 필요 표시", state: "done" },
    { time: "02:47", label: "사용자 확인 대기", state: "doing" },
  ],
  messages: [
    { id: "m1512-1", role: "agent", text: "집 PC의 kaleidoscope 앱스토어에서 사용량 앱에 수동 업데이트 표시가 있는지 확인했습니다.", time: "02:44" },
    { id: "m1512-2", role: "user", text: "지금은 밖이라 직접 못 누릅니다. 목록만 정리해 두세요.", time: "02:46" },
    { id: "m1512-3", role: "agent", text: "업데이트가 필요한 앱 세 개와 현재 버전을 적어 두었습니다. 집에 돌아가서 확인하시면 됩니다.", time: "02:47" },
  ],
};

const ariella: TriageSession = {
  agentName: "아리에라",
  agentId: "ariella",
  preset: "gpt-5.1-codex",
  node: "silent-manari-ts",
  emoji: "🦋",
  status: "review",
  statusLabel: "검수 대기",
  timeline: [
    { time: "11월 15일", label: "설계안 초안 작성", state: "done" },
    { time: "11월 16일", label: "3단계 도입 표 정리", state: "done" },
    { time: "11월 18일", label: "검수 항목 두 건 결과 첨부", state: "done" },
    { time: "11월 18일", label: "검수 대기로 전환", state: "doing" },
  ],
  messages: [
    { id: "m1387-1", role: "agent", text: "턴 안 상호작용은 3단계로 나눠 도입하는 설계안을 정리했습니다. 1단계는 입력 잠금 해제, 2단계는 도구 실행 중 개입, 3단계는 재시작 복구입니다.", time: "11월 15일" },
    { id: "m1387-2", role: "user", text: "1단계와 2단계 사이의 경계를 더 자세히 설명해 주세요.", time: "11월 16일" },
    { id: "m1387-3", role: "agent", text: "경계는 사용자 입력이 큐에 쌓이는 시점입니다. 설계서 3장에 상태 표로 정리했습니다.", time: "11월 16일" },
    { id: "m1387-4", role: "agent", text: "설계서 검수 대기로 넘겼습니다. 확인 항목 네 건 중 두 건은 결과를 붙였고, 두 건은 미확인으로 남겼습니다.", time: "11월 18일" },
  ],
};

const selaphiel: TriageSession = {
  agentName: "세라피엘",
  agentId: "selaphiel",
  preset: "claude-opus-4.5",
  node: "eias-linegames-wsl",
  emoji: "🪽",
  status: "review",
  statusLabel: "검수 대기",
  timeline: [
    { time: "11월 18일", label: "슬라이드 편집 코드 확인", state: "done" },
    { time: "11월 18일", label: "장 유형과 순서 변경 구현", state: "done" },
    { time: "11월 18일", label: "줄간격 보정", state: "done" },
    { time: "11월 18일", label: "좁은 폭 캡처 첨부", state: "done" },
  ],
  messages: [
    { id: "m1408-1", role: "agent", text: "장 유형과 순서 변경, 줄간격 보정을 반영했습니다.", time: "11월 18일" },
    { id: "m1408-2", role: "user", text: "줄간격은 좁은 폭에서도 유지되는지 봐 주세요.", time: "11월 18일" },
    { id: "m1408-3", role: "agent", text: "390px에서 줄간격과 순서 변경이 유지되는 캡처를 첨부했습니다. 인쇄 미리보기는 아직 확인하지 못했습니다.", time: "11월 18일" },
  ],
};

const roselinKaleido: TriageSession = {
  agentName: "로젤린",
  agentId: "roselin",
  preset: "deepseek-flash-4.1",
  node: "eiaserinnys",
  emoji: "🗡️",
  status: "review",
  statusLabel: "검수 대기",
  timeline: [
    { time: "11월 11일", label: "할 일 앱 이전", state: "done" },
    { time: "11월 11일", label: "아침 예약 알림 연결", state: "done" },
    { time: "11월 12일", label: "주말 제외 규칙 추가", state: "done" },
    { time: "11월 19일", label: "8일 관찰 종료", state: "done" },
  ],
  messages: [
    { id: "m1112-1", role: "agent", text: "할 일 앱 이전과 아침 예약 알림 연동을 마쳤습니다.", time: "11월 11일" },
    { id: "m1112-2", role: "user", text: "아침 알림은 주말에 오지 않게 해 주세요.", time: "11월 11일" },
    { id: "m1112-3", role: "agent", text: "주말 제외 규칙을 넣고 8일 동안 관찰했습니다. 놓친 알림은 0건입니다.", time: "11월 19일" },
  ],
};

const watcherContext: TriageSession = {
  agentName: "키키",
  agentId: "kiki",
  preset: "claude-sonnet-4.5",
  node: "eias-linegames",
  emoji: "🐈",
  status: "completed",
  statusLabel: "관찰 중",
  timeline: [
    { time: "11월 16일", label: "요약 문구 조정", state: "done" },
    { time: "11월 16일", label: "관찰 선반으로 이동", state: "done" },
  ],
  messages: [
    { id: "m1610-1", role: "agent", text: "세션 요약 문구 길이를 줄이는 조정을 마쳤습니다. 며칠 더 보시고 결정하셔도 됩니다.", time: "11월 16일" },
  ],
};

const watcherSystem: TriageSession = {
  agentName: "아리에라",
  agentId: "ariella",
  preset: "gpt-5.1-codex",
  node: "silent-manari-ts",
  emoji: "🦋",
  status: "completed",
  statusLabel: "관찰 중",
  timeline: [
    { time: "11월 14일", label: "보고서 문구 초안", state: "done" },
    { time: "11월 14일", label: "관찰 선반으로 이동", state: "done" },
  ],
  messages: [
    { id: "m1592-1", role: "agent", text: "주간 사용량 보고서 문구 초안을 정리했습니다. 다음 주 보고서와 비교해 보시면 됩니다.", time: "11월 14일" },
  ],
};

export const triageCards: readonly TriageCard[] = [
  {
    id: "card-1680",
    number: 1680,
    title: "완료 목록 기간 칩의 기본 선택 범위 결정",
    folderId: "soulstream",
    folderLabel: "✨ 소울스트림",
    kind: "질문",
    tone: "question",
    waited: "15분 전",
    request: "완료 목록을 열 때 기간 칩이 무엇을 기본으로 선택할지 정해 주세요. 지금은 매번 최근 7일로 돌아갑니다.",
    scope: "기본 선택 범위와 기기 기억 여부만 확인하면 됩니다. 목록 자체는 바뀌지 않습니다.",
    items: [
      { title: "최근 7일을 기본으로 두기", state: "done", result: "완료 목록의 첫 화면이 최근 7일로 열립니다." },
      { title: "마지막에 고른 범위 기억", state: "todo", result: "기기에 마지막 선택을 저장하는 방식을 확인해 주세요." },
    ],
    evidence: [
      { id: "ev1680-a", label: "기간 칩 비교", note: "7일과 30일을 나란히 둔 화면", variant: "wide" },
    ],
    session: roselin,
    color: "yellow",
    boardStatus: "blocked",
  },
  {
    id: "card-1512",
    number: 1512,
    title: "집 PC kaleidoscope 앱스토어에서 사용량 앱 수동 업데이트 확인",
    folderId: "kaleidoscope",
    folderLabel: "🔮 kaleidoscope",
    kind: "부탁",
    tone: "open",
    waited: "40분 전",
    request: "집 PC에서 사용량 앱을 직접 업데이트해야 하는지 확인해 주세요. 지금은 원격이라 누를 수 없습니다.",
    scope: "앱스토어 목록과 버전만 확인합니다. 업데이트 실행은 집에 돌아가서 하시면 됩니다.",
    items: [
      { title: "업데이트 필요 앱 세 개 정리", state: "done", result: "앱 이름과 현재 버전을 적었습니다." },
      { title: "업데이트 실행", state: "todo", result: "집 PC에서 직접 눌러야 합니다." },
    ],
    evidence: [
      { id: "ev1512-a", label: "앱스토어 목록", note: "업데이트 표시가 있는 앱 목록", variant: "tall" },
    ],
    session: kiki,
    color: "mint",
    boardStatus: "todo",
  },
  {
    id: "card-1387",
    number: 1387,
    title: "턴 안 상호작용 구현 가능성과 3단계 도입 설계안",
    folderId: "soulstream",
    folderLabel: "✨ 소울스트림",
    kind: "검수 대기",
    tone: "review",
    waited: "4일째 대기",
    request: "도구 실행 중에도 사용자가 말을 걸 수 있게 하려면 어디까지 바꿔야 하는지 설계안을 만들어 주세요.",
    scope: "설계서 3장의 상태 표와 4장의 복구 절차를 확인해 주세요. 구현은 아직 시작하지 않았습니다.",
    items: [
      { title: "1단계 입력 잠금 해제 설계", state: "done", result: "입력 큐와 잠금 해제 시점을 표로 정리했습니다." },
      { title: "2단계 도구 실행 중 개입 설계", state: "changed", result: "개입 시점을 큐 적재 시점으로 고쳤습니다." },
      { title: "3단계 재시작 복구 설계", state: "done", result: "복구 순서와 실패 시 안내를 정리했습니다." },
      { title: "인쇄용 부록", state: "caveat", result: "이번 범위에서 빼 두었습니다." },
    ],
    evidence: [
      { id: "ev1387-a", label: "3단계 도입 표", note: "설계서 3장의 상태 표", variant: "wide" },
      { id: "ev1387-b", label: "개입 시점 흐름도", note: "설계서 4장의 흐름도", variant: "code" },
    ],
    session: ariella,
    color: "blue",
    boardStatus: "review",
  },
  {
    id: "card-1408",
    number: 1408,
    title: "슬라이드 편집 화면 장 유형과 순서 변경 및 줄간격 보정",
    folderId: "pages",
    folderLabel: "🌐 Pages",
    kind: "검수 대기",
    tone: "review",
    waited: "1일 전",
    request: "장 유형을 바꾸고 순서를 옮길 수 있게 해 주세요. 줄간격이 좁은 폭에서 무너지는 문제도 같이 봐 주세요.",
    scope: "편집 화면과 좁은 폭을 확인해 주세요. 인쇄 미리보기는 미확인으로 남겼습니다.",
    items: [
      { title: "장 유형 변경", state: "done", result: "제목, 본문, 이미지 유형이 바뀝니다." },
      { title: "장 순서 변경", state: "done", result: "끌어서 순서를 바꿀 수 있습니다." },
      { title: "줄간격 보정", state: "changed", result: "390px에서 줄간격이 유지됩니다." },
      { title: "인쇄 미리보기", state: "caveat", result: "이번 검수에서 보지 못했습니다." },
    ],
    evidence: [
      { id: "ev1408-a", label: "편집 화면", note: "장 유형과 순서 변경 화면", variant: "wide" },
      { id: "ev1408-b", label: "좁은 폭 캡처", note: "390px 줄간격 확인", variant: "tall" },
    ],
    session: selaphiel,
    color: "pink",
    boardStatus: "review",
  },
  {
    id: "card-1112",
    number: 1112,
    title: "kaleidoscope 할 일 앱 이전과 아침 예약 알림 연동",
    folderId: "kaleidoscope",
    folderLabel: "🔮 kaleidoscope",
    kind: "검수 대기",
    tone: "review",
    waited: "8일째 대기",
    request: "할 일 앱을 kaleidoscope로 옮기고 아침 예약 알림을 연결해 주세요. 주말에는 알림이 오지 않아야 합니다.",
    scope: "8일 관찰 기록만 확인해 주세요. 알림 문구는 기존 그대로입니다.",
    items: [
      { title: "할 일 앱 이전", state: "done", result: "기존 할 일이 모두 옮겨졌습니다." },
      { title: "아침 예약 알림 연결", state: "done", result: "오전 8시 30분에 알림이 뜹니다." },
      { title: "주말 제외 규칙", state: "done", result: "토요일과 일요일에는 알림이 뜨지 않습니다." },
      { title: "8일 관찰 기록", state: "done", result: "놓친 알림 0건입니다." },
    ],
    evidence: [
      { id: "ev1112-a", label: "알림 기록 8일", note: "날짜별 알림 도착 기록", variant: "code" },
    ],
    session: roselinKaleido,
    color: "lavender",
    boardStatus: "review",
  },
];

export const watchCards: readonly TriageCard[] = [
  {
    id: "card-1610",
    number: 1610,
    title: "세션 요약 문구 길이 조정 관찰",
    folderId: "context",
    folderLabel: "🧠 인지와 컨텍스트",
    kind: "관찰",
    tone: "open",
    waited: "3일째 관찰",
    request: "세션 요약이 두 줄을 넘지 않도록 줄여 주세요. 며칠 써 보고 결정하고 싶습니다.",
    scope: "요약 문구 길이만 봅니다. 요약 내용은 그대로입니다.",
    items: [
      { title: "요약 문구 두 줄 제한", state: "done", result: "목록에서 두 줄을 넘지 않습니다." },
    ],
    evidence: [],
    session: watcherContext,
    color: "mint",
    boardStatus: "review",
  },
  {
    id: "card-1592",
    number: 1592,
    title: "주간 사용량 보고서 문구 다듬기",
    folderId: "system",
    folderLabel: "⚙️ 작업 배정",
    kind: "부탁",
    tone: "open",
    waited: "5일째 관찰",
    request: "주간 사용량 보고서의 안내 문구를 조금 더 짧게 다듬어 주세요. 다음 보고서와 비교해 보고 싶습니다.",
    scope: "안내 문구만 확인합니다. 수치 계산은 바뀌지 않습니다.",
    items: [
      { title: "안내 문구 축약", state: "done", result: "세 문장을 두 문장으로 줄였습니다." },
    ],
    evidence: [],
    session: watcherSystem,
    color: "yellow",
    boardStatus: "review",
  },
];

const boardTitles: readonly [number, string, string, BoardStatus, CardColor][] = [
  [1690, "보드 확대 초점 링 다듬기", "dashboard", "todo", "yellow"],
  [1691, "설정 팝오버 간격 정리", "dashboard", "todo", "blue"],
  [1693, "폴더 문서 빈 상태 문구", "soulstream", "todo", "pink"],
  [1694, "세션 목록 키보드 이동", "soulstream", "todo", "mint"],
  [1695, "웹훅 도구 설명 정리", "system", "queued", "lavender"],
  [1696, "완료 칩 색 대비 확인", "pages", "queued", "blue"],
  [1697, "재시작 복구 경로 확인", "soulstream", "blocked", "pink"],
  [1698, "보드 확대 초점 링과 폴더 오류 빈 목록 화면 검수", "dashboard", "running", "yellow"],
  [1699, "컨텍스트 팝오버 다듬기", "context", "running", "mint"],
  [1700, "카드 뷰 스크롤 유지", "soulstream", "running", "blue"],
];

const holdTitles = [
  "첨부 미리보기 확대",
  "알림 문구 정리",
  "세션 이름 규칙",
  "폴더 색 표시",
  "완료 목록 빈 상태",
  "문서 인쇄 여백",
  "카드 복제 단축키",
  "사용량 표 색 대비",
  "모바일 탭 순서",
  "폴더 보관 확인 문구",
  "세션 검색 최근 기록",
  "웹훅 실패 안내",
  "카드 댓글 접기",
  "보드 열 폭 기억",
  "문서 목차 접기",
  "알림 소리 설정",
  "세션 초상 크기",
  "폴더 이동 경로 표시",
] as const;

const doneTitles = [
  "보드 열 머리 정렬",
  "세션 목록 초상 테두리",
  "완료 목록 기간 칩 배치",
  "카드 상세 탭 순서",
  "폴더 카드 빈 목록",
  "알림 배지 위치",
  "문서 편집 저장 표시",
  "모바일 하단 탭 높이",
  "세션 검색 초점",
  "웹훅 목록 빈 상태",
  "카드 색 선택 표시",
  "보드 스크롤 그림자",
] as const;

const agents: readonly [string, string, string][] = [
  ["로젤린", "🗡️", "deepseek-flash-4.1"],
  ["키키", "🐈", "claude-sonnet-4.5"],
  ["아리에라", "🦋", "gpt-5.1-codex"],
  ["세라피엘", "🪽", "claude-opus-4.5"],
];

function folderName(folderId: string): string {
  return mockupFolders.find(folder => folder.id === folderId)?.name ?? "📦 미분류";
}

export const backgroundBoardCards: readonly BoardCard[] = [
  ...boardTitles.map(([number, title, folderId, status, color], index) => {
    const [name, emoji] = agents[index % agents.length]!;
    return {
      id: `board-${number}`,
      number,
      title,
      folderId,
      folderLabel: folderName(folderId),
      status,
      color,
      assigneeName: name,
      assigneeEmoji: emoji,
      activity: "최근 실행 기록을 확인했습니다.",
    };
  }),
  ...holdTitles.map((title, index) => ({
    id: `hold-${index + 1}`,
    number: 1560 + index,
    title,
    folderId: "misc",
    folderLabel: folderName("misc"),
    status: "on_hold" as const,
    color: "lavender" as const,
    assigneeName: "로젤린",
    assigneeEmoji: "🗡️",
    activity: "보류 이유를 적어 두었습니다.",
  })),
  ...doneTitles.map((title, index) => ({
    id: `done-${index + 1}`,
    number: 1540 + index,
    title,
    folderId: index % 2 === 0 ? "dashboard" : "soulstream",
    folderLabel: folderName(index % 2 === 0 ? "dashboard" : "soulstream"),
    status: "done" as const,
    color: "mint" as const,
    assigneeName: "아리에라",
    assigneeEmoji: "🦋",
    activity: "완료 보고를 남겼습니다.",
  })),
];

export const pasMessages: readonly SessionMessage[] = [
  { id: "pas-1", role: "agent", text: "오늘 확인하실 안건이 다섯 건 있습니다. 홈 트리아지에서 장부처럼 넘겨 보실 수 있습니다.", time: "03:10" },
  { id: "pas-2", role: "user", text: "질문 하나만 먼저 볼게요.", time: "03:14" },
  { id: "pas-3", role: "agent", text: "완료 목록 기간 칩의 기본값을 묻는 안건입니다. 홈에서 넘겨 보시면 담당 세션 기록까지 함께 보입니다.", time: "03:15" },
];

export function boardStatusLabel(status: BoardStatus): string {
  switch (status) {
    case "todo": return "할 일";
    case "queued": return "대기";
    case "running": return "진행";
    case "blocked": return "막힘";
    case "review": return "검수";
    case "on_hold": return "보류";
    case "done": return "완료";
  }
}

export function triageCardToBoardCard(card: TriageCard): BoardCard {
  return {
    id: card.id,
    number: card.number,
    title: card.title,
    folderId: card.folderId,
    folderLabel: card.folderLabel,
    status: card.boardStatus,
    color: card.color,
    assigneeName: card.session.agentName,
    assigneeEmoji: card.session.emoji,
    activity: card.items[0]?.result ?? "확인 항목을 정리했습니다.",
  };
}
