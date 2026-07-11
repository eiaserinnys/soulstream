import type { PageLens } from "@seosoyoung/soul-ui/page";

import { V2_TOKENS } from "./v2-token-fixture";

const LENSES: readonly { id: PageLens; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "running", label: "Running" },
  { id: "completed", label: "Completed" },
];

export function V2PageLensControls({
  lens,
  onChange,
}: {
  lens: PageLens;
  onChange(lens: PageLens): void;
}) {
  return (
    <div role="group" aria-label="Session lens" className="flex items-center gap-1">
      {LENSES.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={lens === item.id}
          className={`px-2.5 py-1.5 text-xs font-medium ${V2_TOKENS.control} ${
            lens === item.id ? "bg-primary/12 text-foreground" : "text-muted-foreground"
          }`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
