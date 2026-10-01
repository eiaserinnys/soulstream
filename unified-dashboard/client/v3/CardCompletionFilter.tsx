import { Switch } from "@seosoyoung/soul-ui/components/ui/switch";

export interface CardCompletionOption {
  includeCompleted: boolean;
  onChange(value: boolean): void;
}

/** A view option only; the owner shares it across folder grid and board. */
export function CardCompletionFilter({includeCompleted, onChange, hiddenCount}: CardCompletionOption & {hiddenCount:number}) {
  return <div className="v3-card-completion-filter">
    <label><Switch aria-label="완료 포함" checked={includeCompleted} onCheckedChange={onChange}/><span>완료 포함</span></label>
    {!includeCompleted && hiddenCount > 0 ? <span className="v3-card-completion-hidden">완료 {hiddenCount}개 숨김</span> : null}
  </div>;
}
