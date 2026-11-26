import { useLayoutEffect, useRef } from "react";
import { cn } from "@seosoyoung/soul-ui";
import { ChevronRight, SlidersHorizontal } from "lucide-react";
import { CONFIG_TAB_GROUPS, type ConfigTabDefinition } from "./configTabs";

export interface ConfigCategoryNavItem { name: string; label: string }

/** 목차 밖에서 칸이 정해졌을 때, 현재 칸이 목차 스크롤 영역 안에 다 보이도록 그 영역만 움직인다(창과 페이지는 움직이지 않는다). */
function revealCurrentItem(nav: HTMLElement) {
  const current = nav.querySelector<HTMLElement>('[aria-current="page"]');
  if (!current || nav.clientHeight === 0) return;
  const navBox = nav.getBoundingClientRect();
  const box = current.getBoundingClientRect();
  const scale = navBox.height / nav.clientHeight;
  if (box.top < navBox.top) nav.scrollTop -= (navBox.top - box.top) / scale;
  else if (box.bottom > navBox.bottom) nav.scrollTop += (box.bottom - navBox.bottom) / scale;
}

/** 칸 정의(묶음, 순서, 아이콘)는 configTabs가 정본이고, 서버가 주는 설정 카테고리는 마지막 묶음 끝에 붙는다. */
export function ConfigCategoryNav({ categories, tabs, activeCategory, onSelect, showGroupLabels = true }: {
  categories: ConfigCategoryNavItem[]; tabs: readonly ConfigTabDefinition[];
  activeCategory: string; onSelect(name: string): void;
  showGroupLabels?: boolean;
}) {
  const navRef = useRef<HTMLElement>(null);
  const clickedRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (clickedRef.current === activeCategory) { clickedRef.current = null; return; }
    if (navRef.current) revealCurrentItem(navRef.current);
  }, [activeCategory]);
  const lastGroup = CONFIG_TAB_GROUPS[CONFIG_TAB_GROUPS.length - 1].id;
  const groups = CONFIG_TAB_GROUPS.map(group => ({
    label: group.label,
    items: [
      ...tabs.filter(tab => tab.group === group.id).map(tab => ({ name: tab.id, label: tab.label, Icon: tab.icon })),
      ...(group.id === lastGroup ? categories.map(category => ({ name: category.name, label: category.label, Icon: SlidersHorizontal })) : []),
    ],
  }));
  return <nav ref={navRef} aria-label="설정 카테고리" data-testid="config-category-nav" className="config-category-nav">
    {groups.filter(group => group.items.length).map(group => <section key={group.label}>
      {showGroupLabels ? <h3>{group.label}</h3> : null}
      {group.items.map(({ name, label, Icon }) => <button key={name} type="button"
        aria-current={activeCategory === name ? "page" : undefined}
        onClick={() => { clickedRef.current = name; onSelect(name); }} className={cn("config-category-item", activeCategory === name && "is-active")}>
        <Icon className="size-4" aria-hidden="true"/><span>{label}</span><ChevronRight className="config-category-chevron size-4" aria-hidden="true"/>
      </button>)}
    </section>)}
  </nav>;
}
