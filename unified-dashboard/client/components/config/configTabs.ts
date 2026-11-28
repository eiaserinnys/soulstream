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
  ScrollText,
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
  { id: "personal", label: "settings.groups.personal" },
  { id: "sessions", label: "settings.groups.sessions" },
  { id: "agents", label: "settings.groups.agents" },
  { id: "records", label: "settings.groups.records" },
];

/** 설정창 칸의 정본. 배열 순서가 묶음 안 순서이고, 목차와 본문이 모두 이 정의를 읽는다. */
export const CONFIG_TABS: readonly ConfigTabDefinition[] = [
  { id: "appearance", label: "settings.tabs.appearance.label", description: "settings.tabs.appearance.description", group: "personal", adminOnly: false, icon: Monitor },
  { id: "owned_agents", label: "settings.tabs.owned_agents.label", description: "settings.tabs.owned_agents.description", group: "personal", adminOnly: false, icon: KeyRound },
  { id: "access_links", label: "settings.tabs.access_links.label", description: "settings.tabs.access_links.description", group: "personal", adminOnly: false, icon: Link },
  { id: "webhooks", label: "settings.tabs.webhooks.label", description: "settings.tabs.webhooks.description", group: "personal", adminOnly: false, icon: Webhook },

  { id: "persistent", label: "settings.tabs.persistent.label", description: "settings.tabs.persistent.description", group: "sessions", adminOnly: false, icon: InfinityIcon },
  { id: "persistent_defaults", label: "settings.tabs.persistent_defaults.label", description: "settings.tabs.persistent_defaults.description", group: "sessions", adminOnly: true, icon: Sparkles },
  { id: "summaries", label: "settings.tabs.summaries.label", description: "settings.tabs.summaries.description", group: "sessions", adminOnly: true, icon: ScrollText },
  { id: "card_dispatch", label: "settings.tabs.card_dispatch.label", description: "settings.tabs.card_dispatch.description", group: "sessions", adminOnly: true, icon: Workflow },
  { id: "recurring_jobs", label: "settings.tabs.recurring_jobs.label", description: "settings.tabs.recurring_jobs.description", group: "sessions", adminOnly: false, icon: CalendarClock },

  { id: "agents", label: "settings.tabs.agents.label", description: "settings.tabs.agents.description", group: "agents", adminOnly: true, icon: Bot },
  { id: "mcp", label: "settings.tabs.mcp.label", description: "settings.tabs.mcp.description", group: "agents", adminOnly: true, icon: Plug },
  { id: "skills", label: "settings.tabs.skills.label", description: "settings.tabs.skills.description", group: "agents", adminOnly: true, icon: Library },
  { id: "coding_agents", label: "settings.tabs.coding_agents.label", description: "settings.tabs.coding_agents.description", group: "agents", adminOnly: true, icon: TerminalSquare },
  { id: "git_repos", label: "settings.tabs.git_repos.label", description: "settings.tabs.git_repos.description", group: "agents", adminOnly: true, icon: GitBranch },
  { id: "nodes", label: "settings.tabs.nodes.label", description: "settings.tabs.nodes.description", group: "agents", adminOnly: false, icon: Server },

  { id: "usage_stats", label: "settings.tabs.usage_stats.label", description: "settings.tabs.usage_stats.description", group: "records", adminOnly: false, icon: ChartNoAxesColumnIncreasing },
  { id: "usage_log", label: "settings.tabs.usage_log.label", description: "settings.tabs.usage_log.description", group: "records", adminOnly: false, icon: Activity },
  { id: "session_review", label: "settings.tabs.session_review.label", description: "settings.tabs.session_review.description", group: "records", adminOnly: true, icon: ShieldCheck },
  { id: "users", label: "settings.tabs.users.label", description: "settings.tabs.users.description", group: "records", adminOnly: true, icon: Users },
  { id: "file_storage", label: "settings.tabs.file_storage.label", description: "settings.tabs.file_storage.description", group: "records", adminOnly: true, icon: HardDrive },
];

export const DEFAULT_CONFIG_TAB_ID = "appearance";

export function visibleConfigTabs(isAdmin: boolean, translate: (key: string) => string): ConfigTabDefinition[] {
  return CONFIG_TABS.filter(tab => isAdmin || !tab.adminOnly).map(tab => ({ ...tab, label: translate(tab.label), description: translate(tab.description) }));
}
