export interface LabeledDividerProps {
  label: string;
}

export function LabeledDivider({ label }: LabeledDividerProps) {
  return (
    <div
      className="flex gap-2 px-3 py-1"
      data-slot="labeled-divider-row"
    >
      <span aria-hidden="true" className="w-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <div
          aria-label={label}
          className="my-10 flex items-center gap-3 text-xs font-medium text-muted-foreground"
          role="separator"
        >
          <span aria-hidden="true" className="min-w-0 flex-1 border-t border-input" />
          <span className="min-w-0 truncate text-center">{label}</span>
          <span aria-hidden="true" className="min-w-0 flex-1 border-t border-input" />
        </div>
      </div>
    </div>
  );
}
