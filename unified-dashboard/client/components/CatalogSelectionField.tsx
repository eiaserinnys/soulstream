import { Fragment, useId, type ReactNode, type Ref } from "react";
import { Select, SelectItem, SelectPopup, SelectSeparator, SelectTrigger, SelectValue } from "../../../packages/soul-ui/src/components/ui/select";

/** Agent and model catalogs share the trigger, keyboard handling and option surface. */
export function CatalogSelectionField({ label, ariaLabel, value, selectedLabel, options, disabled,
  invalid, className, labelClassName, description, triggerClassName, triggerRef, adornment, message, onValueChange, onOpenChangeComplete }: {
  label: string; ariaLabel: string; value: string; selectedLabel: ReactNode;
  options: readonly { value: string; label: ReactNode; disabled?: boolean; separatorBefore?: boolean }[];
  disabled?: boolean; invalid?: boolean; className?: string; triggerClassName?: string;
  labelClassName?: string; description?: ReactNode;
  triggerRef?: Ref<HTMLButtonElement>;
  adornment?: ReactNode; message?: ReactNode; onValueChange(value: string): void;
  onOpenChangeComplete?(open: boolean): void;
}) {
  const id = useId();
  const descriptionId = description == null ? undefined : `${id}-description`;
  return <div className={className}>
    <label htmlFor={id} className={labelClassName}>{label}</label>
    {descriptionId && <div id={descriptionId}>{description}</div>}
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Select value={value} disabled={disabled} modal={false} onValueChange={next => onValueChange(next ?? "")} onOpenChangeComplete={onOpenChangeComplete}>
        <SelectTrigger ref={triggerRef} id={id} className={`v3-catalog-select-trigger ${triggerClassName ?? ""}`}
          aria-label={ariaLabel} aria-describedby={descriptionId} aria-invalid={invalid || undefined}>
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectPopup>{options.map(option => <Fragment key={option.value}>{option.separatorBefore && <SelectSeparator/>}<SelectItem value={option.value} disabled={option.disabled}>
          {option.label}
        </SelectItem></Fragment>)}</SelectPopup>
      </Select>
      {adornment}
    </div>
    {message ? <small role="alert">{message}</small> : null}
  </div>;
}
