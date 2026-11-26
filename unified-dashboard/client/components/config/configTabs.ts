import {
  Activity,
  Bot,
  CalendarClock,
  ChartNoAxesColumnIncreasing,
  GitBranch,
  HardDrive,
  Infinity as InfinityIcon,
  KeyRound,
  Library,
  Link,
  Monitor,
  Plug,
  Server,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Users,
  Webhook,
  Workflow,
  type LucideIcon,
} from "lucide-react";

export type ConfigTabGroupId = "personal" | "sessions" | "agents" | "records";

export interface ConfigTabDefinition {
  id: string;
  label: string;
  description: string;
  group: ConfigTabGroupId;
  adminOnly: boolean;
  icon: LucideIcon;
}

/** 목차에 나오는 묶음 순서. 서버가 주는 설정 카테고리는 마지막 묶음 끝에 붙는다. */
export const CONFIG_TAB_GROUPS: ReadonlyArray<{ id: ConfigTabGroupId; label: string }> = [
  { id: "personal", label: "개인 환경" },
  { id: "sessions", label: "세션과 작업" },
  { id: "agents", label: "에이전트와 노드" },
  { id: "records", label: "기록과 관리" },
];

/** 설정창 칸의 정본. 배열 순서가 묶음 안 순서이고, 목차와 본문이 모두 이 정의를 읽는다. */
export const CONFIG_TABS: readonly ConfigTabDefinition[] = [
  { id: "appearance", label: "화면과 읽기", description: "나에게 편안한 배경과 대화 글자 크기를 고릅니다.", group: "personal", adminOnly: false, icon: Monitor },
  { id: "owned_agents", label: "외부 에이전트", description: "외부 에이전트의 이름과 활성 상태, 연결 키를 관리합니다.", group: "personal", adminOnly: false, icon: KeyRound },
  { id: "access_links", label: "접속 링크", description: "외부 에이전트가 내 세션에 일을 맡길 수 있는 링크를 관리합니다.", group: "personal", adminOnly: false, icon: Link },
  { id: "webhooks", label: "웹훅", description: "내 세션과 외부 서비스가 주고받는 웹훅을 관리합니다.", group: "personal", adminOnly: false, icon: Webhook },

  { id: "persistent", label: "영구 에이전트 세션", description: "영구 세션의 지시와 표시, 기록을 관리합니다.", group: "sessions", adminOnly: false, icon: InfinityIcon },
  { id: "persistent_defaults", label: "영구 세션 기본 모델", description: "새 영구 세션이 쓸 기본 모델과 대체 순서를 정합니다. 이미 있는 세션은 바뀌지 않습니다.", group: "sessions", adminOnly: true, icon: Sparkles },
  { id: "card_dispatch", label: "카드 실행", description: "카드의 실행 방식과 동시 실행 수를 조정합니다.", group: "sessions", adminOnly: true, icon: Workflow },
  { id: "recurring_jobs", label: "반복 작업", description: "반복할 작업과 다음 실행 시점을 관리합니다.", group: "sessions", adminOnly: false, icon: CalendarClock },

  { id: "agents", label: "에이전트 프로필", description: "에이전트 프로필과 기본 실행 환경을 관리합니다.", group: "agents", adminOnly: true, icon: Bot },
  { id: "mcp", label: "MCP", description: "중앙 MCP 서버와 프로필, 인증 키를 관리합니다.", group: "agents", adminOnly: true, icon: Plug },
  { id: "skills", label: "스킬과 카탈로그", description: "스킬과 카탈로그의 연결, 쓰이는 곳, 검증 결과를 봅니다.", group: "agents", adminOnly: true, icon: Library },
  { id: "coding_agents", label: "코딩 에이전트 연결", description: "노드마다 Claude, Codex, Antigravity 로그인을 연결합니다.", group: "agents", adminOnly: true, icon: TerminalSquare },
  { id: "git_repos", label: "Git과 저장소", description: "노드마다 Git 사용자, SSH 키, 저장소를 설정합니다.", group: "agents", adminOnly: true, icon: GitBranch },
  { id: "nodes", label: "노드", description: "작업을 실행할 기기와 연결 상태를 확인합니다.", group: "agents", adminOnly: false, icon: Server },

  { id: "usage_stats", label: "세션 통계", description: "기간별 토큰과 정가 환산을 봅니다.", group: "records", adminOnly: false, icon: ChartNoAxesColumnIncreasing },
  { id: "usage_log", label: "사용 로그", description: "사용 기록을 확인하고 필요한 범위로 좁힙니다.", group: "records", adminOnly: false, icon: Activity },
  { id: "session_review", label: "요청 검수", description: "실행 전 검수가 필요한 요청을 정합니다.", group: "records", adminOnly: true, icon: ShieldCheck },
  { id: "users", label: "사용자", description: "서버를 사용할 사람과 접근 범위를 관리합니다.", group: "records", adminOnly: true, icon: Users },
  { id: "file_storage", label: "파일 저장소", description: "첨부 파일을 보관할 저장소를 연결합니다.", group: "records", adminOnly: true, icon: HardDrive },
];

export const DEFAULT_CONFIG_TAB_ID = "appearance";

export function visibleConfigTabs(isAdmin: boolean): ConfigTabDefinition[] {
  return CONFIG_TABS.filter(tab => isAdmin || !tab.adminOnly);
}
