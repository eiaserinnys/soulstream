import { useTranslation } from "react-i18next";
import { Switch } from "@seosoyoung/soul-ui/components/ui/switch";

export interface CardCompletionOption {
  includeCompleted: boolean;
  onChange(value: boolean): void;
}

/** A view option only; the owner shares it across folder grid and board. */
export function CardCompletionFilter({includeCompleted, onChange}: CardCompletionOption & {hiddenCount?:number}) {
 const {t}=useTranslation();
  return <div className="v3-card-completion-filter">
    <label><Switch aria-label={t("cards.hideCompletedAndCancelled")} checked={!includeCompleted} onCheckedChange={value=>onChange(!value)}/><span aria-hidden="true">{t("cards.hideCompletedAndCancelled")}</span></label>
  </div>;
}
