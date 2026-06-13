import { memo } from "react";

/** truncate된 콘텐츠 하단에 표시하는 "전체 내용 보기" 버튼 */
export const ShowFullContentButton = memo(function ShowFullContentButton({
  loading,
  error,
  onClick,
}: {
  loading: boolean;
  error: string | null;
  onClick: () => void;
}) {
  return (
    <div className="mt-1 flex items-center gap-2">
      <button
        onClick={onClick}
        disabled={loading}
        className="text-xs text-accent-blue hover:text-accent-blue/80 flex items-center gap-1 disabled:opacity-50"
      >
        {loading ? (
          <>
            <span className="inline-block w-3 h-3 border border-accent-blue/40 border-t-accent-blue rounded-full animate-spin" />
            Loading...
          </>
        ) : (
          "\u2026 전체 내용 보기"
        )}
      </button>
      {error && (
        <span className="text-xs chat-tone-danger-text">{error}</span>
      )}
    </div>
  );
});
