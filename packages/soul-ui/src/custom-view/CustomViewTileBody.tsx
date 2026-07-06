import { CustomViewIframe } from "./CustomViewRenderer";
import { useCustomViewBindings, useCustomViewDocument } from "./use-custom-view-bindings";

/**
 * 보드 타일용 라이브 커스텀 뷰 위젯.
 * - 타일에서 바로 sandboxed iframe을 렌더한다 (위젯 메타포어).
 * - `pointer-events: none`으로 드래그·클릭이 타일 버튼으로 통과한다.
 * - 문서 로드 전에는 정적 프리뷰 텍스트로 폴백.
 */
export function CustomViewTileBody({
  customViewId,
  title,
  fallbackPreview,
}: {
  customViewId: string;
  title: string;
  fallbackPreview: string;
}) {
  const projection = useCustomViewDocument(customViewId);
  const bindings = useCustomViewBindings();
  const document = projection?.document ?? null;

  if (!document) {
    return (
      <div
        data-testid="board-custom-view-preview"
        className="mt-2 line-clamp-3 text-xs leading-[1.55] text-muted-foreground"
      >
        {fallbackPreview || "Empty custom view"}
      </div>
    );
  }

  return (
    <div className="mt-2 min-h-0 flex-1 overflow-hidden rounded-md">
      <CustomViewIframe
        html={document.html}
        bindings={bindings}
        title={title}
        className="pointer-events-none h-full w-full border-0 bg-white"
      />
    </div>
  );
}
