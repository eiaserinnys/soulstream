import type { FormEventHandler } from "react";

import { cn } from "../lib/cn";
import { Button } from "./ui/button";

interface InputRequestAnswerFormProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  inputDisabled: boolean;
  submitDisabled: boolean;
  inputTextClassName: string;
}

export function InputRequestAnswerForm({
  value,
  onValueChange,
  onSubmit,
  inputDisabled,
  submitDisabled,
  inputTextClassName,
}: InputRequestAnswerFormProps) {
  return (
    <form className="flex gap-2" onSubmit={onSubmit}>
      <input
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        disabled={inputDisabled}
        placeholder="직접 입력"
        className={cn(
          "min-w-0 flex-1 rounded-[13px] border border-[var(--lg-line)] bg-muted/40 px-3 py-2 outline-none transition-colors focus:border-accent-blue/55",
          inputTextClassName,
        )}
      />
      <Button
        type="submit"
        size="xs"
        disabled={submitDisabled}
        className="h-auto self-stretch rounded-[13px] px-3 text-xs font-semibold sm:h-auto"
      >
        전송
      </Button>
    </form>
  );
}
