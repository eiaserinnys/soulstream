import type { InputRequestQuestion } from "../shared/types";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

type InputRequestOption = InputRequestQuestion["options"][number];

interface InputRequestOptionContentProps {
  option: InputRequestOption;
  descriptionClassName?: string;
  /** 카드 #1197: 이름 옆 표시(권함 배지). */
  labelAccessory?: ReactNode;
  /** 카드 #1197: 좁은 장 안에서 이름 아래에 설명을 쌓는다. */
  layout?: "columns" | "stack";
}

const OPTION_STACK_CLASS = "grid w-full min-w-0 grid-cols-1 items-start gap-y-1 text-left";
const OPTION_GRID_CLASS =
  "grid w-full min-w-0 grid-cols-[minmax(11rem,0.85fr)_minmax(0,1.35fr)] items-start gap-x-3 gap-y-1 text-left max-[560px]:grid-cols-1";

export function InputRequestOptionContent({
  option,
  descriptionClassName,
  labelAccessory,
  layout = "columns",
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
        {labelAccessory}
      </span>
    );
  }

  return (
    <span data-testid="input-request-option-content" data-layout={layout} className={layout === "stack" ? OPTION_STACK_CLASS : OPTION_GRID_CLASS}>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <b
          data-testid="input-request-option-label"
          className="min-w-0 whitespace-normal break-keep [overflow-wrap:anywhere] font-semibold"
        >
          {option.label}
        </b>
        {labelAccessory}
      </span>
      <small
        data-testid="input-request-option-description"
        className={cn("mt-0 min-w-0 leading-[1.45] text-muted-foreground", descriptionClassName)}
      >
        {option.description}
      </small>
    </span>
  );
}
