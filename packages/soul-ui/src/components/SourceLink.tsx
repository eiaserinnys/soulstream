import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/cn";
import { useInternalLinkClick } from "./InternalLinkProvider";

const sourceLinkClassName =
  "inline-block w-fit max-w-full rounded-lg text-accent-blue hover:underline outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

export function SourceLink({
  className,
  onClick,
  target = "_blank",
  rel = "noopener noreferrer",
  node,
  ...props
}: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  void node;
  const handleInternalLinkClick = useInternalLinkClick();

  return (
    <a
      {...props}
      className={cn(sourceLinkClassName, className)}
      target={target}
      rel={rel}
      onClick={(event) => {
        onClick?.(event);
        handleInternalLinkClick(event);
      }}
    />
  );
}
