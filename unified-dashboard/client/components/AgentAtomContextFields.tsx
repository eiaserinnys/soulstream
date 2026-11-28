import { useTranslation } from "react-i18next";
import type { InputHTMLAttributes } from "react";
import { Button } from "@seosoyoung/soul-ui";

export type AppliesWhenField = "source" | "node_id" | "folder_id" | "agent" | "backend" | "os" | "card_role";
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
  { field: "source", label: "agents.context.callerSource" },
  { field: "node_id", label: "agents.context.sessionNode" },
  { field: "folder_id", label: "agents.context.folderId" },
  { field: "agent", label: "agents.agent" },
  { field: "backend", label: "agents.context.backend" },
  { field: "os", label: "agents.context.os" },
  { field: "card_role", label: "agents.context.cardRole" },
];

export const inputClassName = "mt-1 h-8 w-full rounded-floor border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

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
  const { t } = useTranslation();
  return (
    <div className="rounded-floor border border-border bg-muted/10 p-3">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 lg:grid-cols-[minmax(0,1fr)_7rem_5rem_auto]">
        <div className="col-span-full min-w-0 lg:col-span-1"><LabeledInput
          label="Atom node UUID"
          value={context.node_id}
          onChange={(value) => onChange({ ...context, node_id: value })}
        /></div>
        <label className="text-xs font-medium">
          {t("agents.context.mode")}
          <select
            aria-label={t("agents.context.modeLabel", { number: index + 1 })}
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
          label={t("agents.context.depth")}
          type="number"
          min="0"
          value={context.depth === undefined ? "" : String(context.depth)}
          onChange={(value) => {
            const { depth: _removed, ...withoutDepth } = context;
            onChange(value === "" ? withoutDepth : { ...context, depth: Number(value) });
          }}
        />
        <Button type="button" size="sm" variant="ghost" className="mt-5" onClick={onRemove}>{t("agents.delete")}</Button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-3">
        {CONDITION_FIELDS.map(({ field, label }) => (
          <LabeledInput
            key={field}
            label={t("agents.context.conditionLabel", { label: t(label) })}
            placeholder={t("agents.context.separateConditions")}
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
