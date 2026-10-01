import { useId, type ReactNode } from "react";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "@seosoyoung/soul-ui";

/** Agent and model catalogs share the trigger, keyboard handling and option surface. */
export function CatalogSelectionField({ label, ariaLabel, value, selectedLabel, options, disabled,
  invalid, className, triggerClassName, adornment, message, onValueChange }: {
  label: string; ariaLabel: string; value: string; selectedLabel: ReactNode;
  options: readonly { value: string; label: ReactNode; disabled?: boolean }[];
  disabled?: boolean; invalid?: boolean; className?: string; triggerClassName?: string;
  adornment?: ReactNode; message?: ReactNode; onValueChange(value: string): void;
}) {
  const id = useId();
  return <div className={className}>
    <label htmlFor={id}>{label}</label>
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Select value={value} disabled={disabled} modal={false} onValueChange={next => onValueChange(next ?? "")}>
        <SelectTrigger id={id} className={`v3-catalog-select-trigger ${triggerClassName ?? ""}`}
          aria-label={ariaLabel} aria-invalid={invalid || undefined}>
          <span className="flex-1 truncate">{selectedLabel}</span>
        </SelectTrigger>
        <SelectPopup>{options.map(option => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </SelectItem>)}</SelectPopup>
      </Select>
      {adornment}
    </div>
    {message ? <small role="alert">{message}</small> : null}
  </div>;
}
