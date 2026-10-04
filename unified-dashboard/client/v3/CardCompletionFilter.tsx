import { Switch } from "@seosoyoung/soul-ui/components/ui/switch";

export interface CardCompletionOption {
  includeCompleted: boolean;
  onChange(value: boolean): void;
}

/** A view option only; the owner shares it across folder grid and board. */
export function CardCompletionFilter({includeCompleted, onChange}: CardCompletionOption & {hiddenCount?:number}) {
  return <div className="v3-card-completion-filter">
    <label><Switch aria-label="완료·취소 숨김" checked={!includeCompleted} onCheckedChange={value=>onChange(!value)}/><span>완료·취소 숨김</span></label>
  </div>;
}
