export interface LabeledDividerProps {
  label: string;
}

export function LabeledDivider({ label }: LabeledDividerProps) {
  return (
    <div
      aria-label={label}
      className="mb-10 flex items-center gap-3 text-xs font-medium text-muted-foreground"
      role="separator"
    >
      <span aria-hidden="true" className="min-w-0 flex-1 border-t border-border" />
      <span className="shrink-0">{label}</span>
      <span aria-hidden="true" className="min-w-0 flex-1 border-t border-border" />
    </div>
  );
}
