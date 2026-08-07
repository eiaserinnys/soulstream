import { Trash2 } from "lucide-react";

export type AtomRenderMode = "full" | "index" | "titles";

export function SelectedAtomOption({
  title,
  meta,
  depth,
  titlesOnly,
  mode,
  limit,
  disabled,
  onOptionsChange,
  onRemove,
}: {
  title: string;
  meta: string;
  depth: number;
  titlesOnly: boolean;
  mode?: AtomRenderMode;
  limit?: number;
  disabled: boolean;
  onOptionsChange(
    depth: number,
    titlesOnly: boolean,
    mode: AtomRenderMode | undefined,
    limit?: number,
  ): void;
  onRemove(): void;
}) {
  return (
    <div className="v3-context-option v3-context-option--selected">
      <span className="v3-emoji" aria-hidden="true">🧠</span>
      <span><strong>{title}</strong><small>{meta}</small></span>
      <span className="v3-context-option-settings">
        <label>
          depth
          <select
            aria-label={`${title} atom depth`}
            value={depth}
            disabled={disabled}
            onChange={(event) => onOptionsChange(Number(event.target.value), titlesOnly, mode, limit)}
          >
            {[1, 2, 3, 4, 5].map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          최근 자식 수
          <input
            type="number"
            min={1}
            value={limit ?? ""}
            placeholder="전체"
            aria-label={`${title} 최근 자식 수`}
            disabled={disabled}
            onChange={(event) => onOptionsChange(
              depth,
              titlesOnly,
              mode,
              event.target.value === "" ? undefined : Number(event.target.value),
            )}
          />
        </label>
        <label>
          렌더 방식
          <select
            aria-label={`${title} atom 렌더 방식`}
            value={mode ?? ""}
            disabled={disabled}
            onChange={(event) => onOptionsChange(
              depth,
              titlesOnly,
              event.target.value
                ? event.target.value as AtomRenderMode
                : undefined,
              limit,
            )}
          >
            <option value="">기존 방식</option>
            <option value="full">전체 본문</option>
            <option value="index">색인</option>
            <option value="titles">제목 트리</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            aria-label={`${title} 제목만 포함`}
            checked={titlesOnly}
            disabled={disabled}
            onChange={(event) => onOptionsChange(depth, event.target.checked, mode, limit)}
          />
          제목만
        </label>
      </span>
      <button
        type="button"
        className="v3-context-remove"
        aria-label={`${title} atom 제거`}
        disabled={disabled}
        onClick={onRemove}
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function withAtomOptions<T extends {
  depth: number;
  titlesOnly: boolean;
  limit?: number;
  mode?: AtomRenderMode;
}>(
  reference: T,
  depth: number,
  titlesOnly: boolean,
  mode: AtomRenderMode | undefined,
  limit?: number,
): T {
  const updated = { ...reference, depth, titlesOnly, mode, limit };
  if (limit === undefined) delete updated.limit;
  if (mode === undefined) delete updated.mode;
  return updated;
}
