export type ReferenceAutocompleteOption =
  | { readonly kind: "page"; readonly id: string; readonly label: string; readonly detail: string }
  | { readonly kind: "session"; readonly id: string; readonly label: string; readonly detail: string }
  | { readonly kind: "block"; readonly id: string; readonly label: string; readonly detail: string };

const GROUP_LABELS = {
  page: "Pages",
  session: "Sessions",
  block: "Blocks",
} as const;

export function PageReferenceAutocomplete({
  options,
  activeIndex,
  loading,
  onChoose,
  onActiveIndexChange,
}: {
  options: readonly ReferenceAutocompleteOption[];
  activeIndex: number;
  loading: boolean;
  onChoose(option: ReferenceAutocompleteOption): void;
  onActiveIndexChange(index: number): void;
}) {
  const groups = (["page", "session", "block"] as const)
    .map((kind) => ({ kind, options: options.map((option, index) => ({ option, index })).filter(({ option }) => option.kind === kind) }))
    .filter(({ options: values }) => values.length > 0);
  return (
    <div
      role="listbox"
      aria-label="Reference suggestions"
      className="absolute left-0 top-full z-30 mt-1 max-h-64 w-full min-w-72 overflow-auto rounded-lg border border-glass-border bg-background/95 p-1 shadow-xl backdrop-blur"
    >
      {groups.map((group) => (
        <div key={group.kind} role="group" aria-label={GROUP_LABELS[group.kind]}>
          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {GROUP_LABELS[group.kind]}
          </p>
          {group.options.map(({ option, index }) => (
            <button
              key={`${option.kind}:${option.id}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`flex w-full items-start justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm ${index === activeIndex ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-glass-highlight/50 hover:text-foreground"}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onActiveIndexChange(index)}
              onClick={() => onChoose(option)}
            >
              <span className="min-w-0 truncate font-medium">{option.label}</span>
              <span className="shrink-0 truncate text-xs text-muted-foreground">{option.detail}</span>
            </button>
          ))}
        </div>
      ))}
      {options.length === 0 ? (
        <p className="px-2 py-2 text-sm text-muted-foreground">
          {loading ? "Searching…" : "No matching references."}
        </p>
      ) : null}
    </div>
  );
}
