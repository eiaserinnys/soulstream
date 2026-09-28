import type { InputHTMLAttributes } from "react";
import { Button } from "@seosoyoung/soul-ui";

export type AppliesWhenField = "source" | "node_id" | "container_kind" | "agent" | "backend" | "os";
export type AtomContextMode = "full" | "index" | "titles";

export interface AgentAtomContext {
  node_id: string;
  depth?: number;
  titles_only?: boolean;
  include_ids?: boolean;
  mode?: AtomContextMode;
  applies_when?: Record<string, unknown>;
}

const CONDITION_FIELDS: ReadonlyArray<{ field: AppliesWhenField; label: string }> = [
  { field: "source", label: "호출 소스" },
  { field: "node_id", label: "세션 노드" },
  { field: "container_kind", label: "컨테이너 종류" },
  { field: "agent", label: "에이전트" },
  { field: "backend", label: "백엔드" },
  { field: "os", label: "OS" },
];

export const inputClassName = "mt-1 h-8 w-full rounded border border-border bg-background px-2 text-sm";

export function LabeledInput({ label, value, onChange, ...props }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <label className="text-xs font-medium">
      {label}
      <input aria-label={label} className={inputClassName} value={value} onChange={(event) => onChange(event.target.value)} {...props} />
    </label>
  );
}

export function AgentAtomContextFields({ context, index, onChange, onRemove }: {
  context: AgentAtomContext;
  index: number;
  onChange: (context: AgentAtomContext) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded border border-border bg-muted/10 p-3">
      <div className="grid grid-cols-[minmax(0,1fr)_7rem_5rem_auto] gap-2">
        <LabeledInput
          label="Atom node UUID"
          value={context.node_id}
          onChange={(value) => onChange({ ...context, node_id: value })}
        />
        <label className="text-xs font-medium">
          모드
          <select
            aria-label={`컨텍스트 ${index + 1} 모드`}
            className={inputClassName}
            value={context.mode ?? "full"}
            onChange={(event) => onChange({ ...context, mode: event.target.value as AtomContextMode })}
          >
            <option value="full">full</option>
            <option value="index">index</option>
            <option value="titles">titles</option>
          </select>
        </label>
        <LabeledInput
          label="깊이"
          type="number"
          min="0"
          value={context.depth === undefined ? "" : String(context.depth)}
          onChange={(value) => {
            const { depth: _removed, ...withoutDepth } = context;
            onChange(value === "" ? withoutDepth : { ...context, depth: Number(value) });
          }}
        />
        <Button type="button" size="sm" variant="ghost" className="mt-5" onClick={onRemove}>삭제</Button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-3">
        {CONDITION_FIELDS.map(({ field, label }) => (
          <LabeledInput
            key={field}
            label={`조건 · ${label}`}
            placeholder="쉼표로 OR"
            value={conditionText(context.applies_when?.[field])}
            onChange={(value) => onChange(updateCondition(context, field, value))}
          />
        ))}
      </div>
    </div>
  );
}

export function conditionSummary(appliesWhen: AgentAtomContext["applies_when"]): string {
  if (!appliesWhen) return "";
  return Object.entries(appliesWhen)
    .map(([field, value]) => {
      const text = conditionText(value);
      return text ? `${field}: ${text}` : "";
    })
    .filter(Boolean)
    .join(" · ");
}

function updateCondition(context: AgentAtomContext, field: AppliesWhenField, text: string): AgentAtomContext {
  const appliesWhen = { ...(context.applies_when ?? {}) };
  const values = text.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length > 0) appliesWhen[field] = values;
  else delete appliesWhen[field];
  if (Object.keys(appliesWhen).length === 0) {
    const { applies_when: _removed, ...withoutCondition } = context;
    return withoutCondition;
  }
  return { ...context, applies_when: appliesWhen };
}

function conditionText(value: unknown): string {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").join(", ");
  return typeof value === "string" ? value : "";
}
