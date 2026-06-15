import type { InputRequestQuestion } from "../shared/types";
import { cn } from "../lib/cn";

type InputRequestOption = InputRequestQuestion["options"][number];

interface InputRequestOptionContentProps {
  option: InputRequestOption;
  descriptionClassName?: string;
}

const OPTION_GRID_CLASS =
  "grid w-full min-w-0 grid-cols-[minmax(11rem,0.85fr)_minmax(0,1.35fr)] items-start gap-x-3 gap-y-1 text-left max-[560px]:grid-cols-1";

export function InputRequestOptionContent({
  option,
  descriptionClassName,
}: InputRequestOptionContentProps) {
  if (!option.description) {
    return (
      <span data-testid="input-request-option-content" className="block w-full min-w-0 text-left">
        <b
          data-testid="input-request-option-label"
          className="min-w-0 whitespace-normal break-keep [overflow-wrap:anywhere] font-semibold"
        >
          {option.label}
        </b>
      </span>
    );
  }

  return (
    <span data-testid="input-request-option-content" className={OPTION_GRID_CLASS}>
      <b
        data-testid="input-request-option-label"
        className="min-w-0 whitespace-normal break-keep [overflow-wrap:anywhere] font-semibold"
      >
        {option.label}
      </b>
      <small
        data-testid="input-request-option-description"
        className={cn("mt-0 min-w-0 leading-[1.45] text-muted-foreground", descriptionClassName)}
      >
        {option.description}
      </small>
    </span>
  );
}
