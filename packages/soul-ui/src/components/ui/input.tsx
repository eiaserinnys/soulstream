"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import type * as React from "react";

import { cn } from "../../lib/cn";

type InputProps = Omit<
  InputPrimitive.Props & React.RefAttributes<HTMLInputElement>,
  "size"
> & {
  size?: "sm" | "default" | "lg" | number;
  unstyled?: boolean;
  nativeInput?: boolean;
};

/** Input의 표면(테두리, 바탕, 그림자)과 포커스 모양. 같은 표면이 필요한 다른 입력(여러 줄 입력 등)이 이 문자열을 그대로 쓴다. */
const inputControlClassName =
  "relative inline-flex w-full rounded-lg border border-input control-surface not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] sm:text-sm dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]";

/** Input 안쪽 입력의 가로 안쪽 여백과 모양. 높이와 줄 간격은 한 줄 입력만의 것이라 포함하지 않는다. */
const inputFieldClassName =
  "w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] outline-none placeholder:text-muted-foreground/72";

function Input({
  className,
  size = "default",
  unstyled = false,
  nativeInput = false,
  ...props
}: InputProps) {
  const inputClassName = cn(
    inputFieldClassName,
    "h-8.5 leading-8.5 sm:h-7.5 sm:leading-7.5 [transition:background-color_5000000s_ease-in-out_0s]",
    size === "sm" &&
      "h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5",
    size === "lg" && "h-9.5 leading-9.5 sm:h-8.5 sm:leading-8.5",
    props.type === "search" &&
      "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none",
    props.type === "file" &&
      "text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm",
  );

  return (
    <span
      className={
        cn(
          !unstyled &&
            inputControlClassName,
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      {nativeInput ? (
        <input
          className={inputClassName}
          data-slot="input"
          size={typeof size === "number" ? size : undefined}
          {...props}
        />
      ) : (
        <InputPrimitive
          className={inputClassName}
          data-slot="input"
          size={typeof size === "number" ? size : undefined}
          {...props}
        />
      )}
    </span>
  );
}

export { Input, inputControlClassName, inputFieldClassName, type InputProps };
