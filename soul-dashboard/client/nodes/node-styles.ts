/**
 * 공통 노드 스타일 유틸리티
 *
 * React Flow 노드 컴포넌트에서 공유하는 스타일 상수와 유틸리티.
 * 노드 크기 260x84px은 layout-engine과 동기화되어 있으므로 절대 변경하지 않는다.
 */

/** 노드 기본 클래스 (260x84 고정, border-box) */
export const nodeBase = "w-[260px] h-[84px] box-border rounded-lg shadow-[0_2px_8px_rgba(0,0,0,0.4)] flex overflow-hidden";

/** 노드 배경 (기본 다크) */
export const nodeBgDefault = "bg-card";

/** 노드 콘텐츠 영역 */
export const nodeContent = "flex-1 px-3 py-2.5 min-w-0";

/** 노드 헤더 행 */
export const nodeHeader = "flex items-center gap-1.5 mb-1.5";

/** 노드 라벨 텍스트 */
export const nodeLabel = "text-[10px] uppercase tracking-[0.05em] font-semibold";

/** 텍스트 줄임 (2줄) */
export const truncate2 = "line-clamp-2";

/** Handle 공통 style (React Flow Handle은 style prop 필수) */
export function handleStyle(color: string) {
  return {
    width: 8,
    height: 8,
    background: color,
    border: '2px solid rgba(17, 24, 39, 0.95)',
  };
}

/** 작은 Handle style (system node 등) */
export function handleStyleSmall(color: string) {
  return {
    width: 6,
    height: 6,
    background: color,
    border: '2px solid rgba(17, 24, 39, 0.95)',
  };
}
