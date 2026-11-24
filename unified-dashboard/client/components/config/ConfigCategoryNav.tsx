import { cn } from "@seosoyoung/soul-ui";
import { ChartNoAxesColumnIncreasing, ChevronRight, Monitor, Server, Workflow, Users, ShieldCheck, HardDrive, CalendarClock, Activity, Bot, Infinity as InfinityIcon, SlidersHorizontal, Link, Webhook, Plug, TerminalSquare } from "lucide-react";
export interface ConfigCategoryNavItem { name: string; label: string }
const icons: Record<string, typeof Monitor> = { appearance: Monitor, access_links: Link, webhooks: Webhook, account: Users, display: Monitor, record: Activity, nodes: Server, card_dispatch: Workflow, users: Users, session_review: ShieldCheck, file_storage: HardDrive, recurring_jobs: CalendarClock, persistent: InfinityIcon, coding_agents: TerminalSquare, usage_log: Activity, usage_stats: ChartNoAxesColumnIncreasing, mcp: Plug, agents: Bot };
const personal = new Set(["appearance", "owned_agents", "access_links", "webhooks"]);
const execution = new Set(["nodes", "coding_agents", "mcp", "agents", "card_dispatch", "persistent_defaults", "recurring_jobs", "persistent"]);
export function ConfigCategoryNav({ categories, extraTabs = [], activeCategory, onSelect, showGroupLabels = true }: {
  categories: ConfigCategoryNavItem[]; extraTabs?: ConfigCategoryNavItem[];
  activeCategory: string; onSelect(name: string): void;
  showGroupLabels?: boolean;
}) {
  const all = [...extraTabs, ...categories];
  const groups = [
    { label: "개인 환경", items: all.filter(item => personal.has(item.name)) },
    { label: "작업과 실행", items: all.filter(item => execution.has(item.name)) },
    { label: "서버 관리", items: all.filter(item => !personal.has(item.name) && !execution.has(item.name)) },
  ];
  return <nav aria-label="설정 카테고리" data-testid="config-category-nav" className="config-category-nav">
    {groups.filter(group => group.items.length).map(group => <section key={group.label}>
      {showGroupLabels ? <h3>{group.label}</h3> : null}
      {group.items.map(cat => { const Icon = icons[cat.name] ?? SlidersHorizontal; return <button key={cat.name} type="button"
        aria-current={activeCategory === cat.name ? "page" : undefined}
        onClick={() => onSelect(cat.name)} className={cn("config-category-item", activeCategory === cat.name && "is-active")}>
        <Icon className="size-4" aria-hidden="true"/><span>{cat.label}</span><ChevronRight className="config-category-chevron size-4" aria-hidden="true"/>
      </button>; })}
    </section>)}
  </nav>;
}
