import { cn } from "@seosoyoung/soul-ui";
import { ChevronRight, Monitor, Server, Workflow, Users, ShieldCheck, HardDrive, CalendarClock, Activity, Bot, Infinity as InfinityIcon, SlidersHorizontal } from "lucide-react";
export interface ConfigCategoryNavItem { name: string; label: string }
const icons: Record<string, typeof Monitor> = { appearance: Monitor, nodes: Server, card_dispatch: Workflow, users: Users, session_review: ShieldCheck, file_storage: HardDrive, recurring_jobs: CalendarClock, persistent: InfinityIcon, usage_log: Activity, agents: Bot };
const execution = new Set(["nodes", "agents", "card_dispatch", "recurring_jobs", "persistent"]);
export function ConfigCategoryNav({ categories, extraTabs = [], activeCategory, onSelect }: {
  categories: ConfigCategoryNavItem[]; extraTabs?: ConfigCategoryNavItem[];
  activeCategory: string; onSelect(name: string): void;
}) {
  const all = [...extraTabs, ...categories];
  const groups = [
    { label: "개인 환경", items: all.filter(item => item.name === "appearance" || item.name === "owned_agents") },
    { label: "작업과 실행", items: all.filter(item => execution.has(item.name)) },
    { label: "서버 관리", items: all.filter(item => item.name !== "appearance" && item.name !== "owned_agents" && !execution.has(item.name)) },
  ];
  return <nav aria-label="설정 카테고리" data-testid="config-category-nav" className="config-category-nav">
    {groups.filter(group => group.items.length).map(group => <section key={group.label}>
      <h3>{group.label}</h3>
      {group.items.map(cat => { const Icon = icons[cat.name] ?? SlidersHorizontal; return <button key={cat.name} type="button"
        aria-current={activeCategory === cat.name ? "page" : undefined}
        onClick={() => onSelect(cat.name)} className={cn("config-category-item", activeCategory === cat.name && "is-active")}>
        <Icon className="size-4" aria-hidden="true"/><span>{cat.label}</span><ChevronRight className="config-category-chevron size-4" aria-hidden="true"/>
      </button>; })}
    </section>)}
  </nav>;
}
