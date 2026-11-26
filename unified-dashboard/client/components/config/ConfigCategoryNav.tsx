import { cn } from "@seosoyoung/soul-ui";
import { ChevronRight, SlidersHorizontal } from "lucide-react";
import { CONFIG_TAB_GROUPS, type ConfigTabDefinition } from "./configTabs";

export interface ConfigCategoryNavItem { name: string; label: string }

/** 칸 정의(묶음, 순서, 아이콘)는 configTabs가 정본이고, 서버가 주는 설정 카테고리는 마지막 묶음 끝에 붙는다. */
export function ConfigCategoryNav({ categories, tabs, activeCategory, onSelect, showGroupLabels = true }: {
  categories: ConfigCategoryNavItem[]; tabs: readonly ConfigTabDefinition[];
  activeCategory: string; onSelect(name: string): void;
  showGroupLabels?: boolean;
}) {
  const lastGroup = CONFIG_TAB_GROUPS[CONFIG_TAB_GROUPS.length - 1].id;
  const groups = CONFIG_TAB_GROUPS.map(group => ({
    label: group.label,
    items: [
      ...tabs.filter(tab => tab.group === group.id).map(tab => ({ name: tab.id, label: tab.label, Icon: tab.icon })),
      ...(group.id === lastGroup ? categories.map(category => ({ name: category.name, label: category.label, Icon: SlidersHorizontal })) : []),
    ],
  }));
  return <nav aria-label="설정 카테고리" data-testid="config-category-nav" className="config-category-nav">
    {groups.filter(group => group.items.length).map(group => <section key={group.label}>
      {showGroupLabels ? <h3>{group.label}</h3> : null}
      {group.items.map(({ name, label, Icon }) => <button key={name} type="button"
        aria-current={activeCategory === name ? "page" : undefined}
        onClick={() => onSelect(name)} className={cn("config-category-item", activeCategory === name && "is-active")}>
        <Icon className="size-4" aria-hidden="true"/><span>{label}</span><ChevronRight className="config-category-chevron size-4" aria-hidden="true"/>
      </button>)}
    </section>)}
  </nav>;
}
