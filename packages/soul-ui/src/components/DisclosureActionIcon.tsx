import { ChevronDown, ChevronUp, type LucideProps } from "lucide-react";

export interface DisclosureActionIconProps extends LucideProps {
  expanded: boolean;
}

export function DisclosureActionIcon({ expanded, ...props }: DisclosureActionIconProps) {
  const Icon = expanded ? ChevronUp : ChevronDown;
  return <Icon aria-hidden="true" {...props} />;
}
