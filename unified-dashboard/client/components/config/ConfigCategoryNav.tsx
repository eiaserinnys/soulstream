/**
 * ConfigCategoryNav — 설정 카테고리 네비게이션 탭
 *
 * 서버 설정 카테고리 + (선택적) Claude Auth 보조 탭을 표시한다.
 */

import { cn } from "@seosoyoung/soul-ui";

export interface ConfigCategoryNavItem {
  name: string;
  label: string;
}

export function ConfigCategoryNav({
  categories,
  extraTabs = [],
  activeCategory,
  onSelect,
}: {
  categories: ConfigCategoryNavItem[];
  extraTabs?: ConfigCategoryNavItem[];
  activeCategory: string;
  onSelect: (name: string) => void;
}) {
  const all = [...categories, ...extraTabs];

  return (
    <div
      role="tablist"
      className="flex flex-wrap gap-1 mb-4 border-b border-border pb-2"
    >
      {all.map((cat) => (
        <button
          key={cat.name}
          type="button"
          role="tab"
          aria-selected={activeCategory === cat.name}
          onClick={() => onSelect(cat.name)}
          className={cn(
            "px-3 py-1.5 text-xs rounded-t transition-colors",
            activeCategory === cat.name
              ? "bg-muted text-foreground border-b-2 border-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
          )}
        >
          {cat.label}
        </button>
      ))}
    </div>
  );
}
