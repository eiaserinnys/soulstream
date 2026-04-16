/**
 * SettingFieldWidget — 설정 필드 입력 위젯
 *
 * value_type(str/int/float/bool/csv)별 입력 분기,
 * sensitive 마스킹(show/hide 토글),
 * read_only disabled, hot_reloadable 인디케이터를 제공한다.
 */

import { useState } from "react";
import { cn } from "@seosoyoung/soul-ui";
import { Eye, EyeOff, RotateCcw } from "lucide-react";

export interface SettingField {
  key: string;
  field_name: string;
  label: string;
  description: string;
  value: string | number | boolean | null;
  value_type: "str" | "int" | "float" | "bool" | "csv";
  sensitive: boolean;
  hot_reloadable: boolean;
  read_only: boolean;
}

function BoolToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
        value ? "bg-primary" : "bg-input",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <span
        className={cn(
          "pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform",
          value ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}

function SensitiveInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="flex items-center gap-1">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(
          "flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground",
          "focus:outline-none focus:ring-1 focus:ring-ring",
          disabled && "opacity-50 cursor-not-allowed",
        )}
      />
      <button
        type="button"
        onClick={() => setVisible(!visible)}
        className="p-1 text-muted-foreground hover:text-foreground transition-colors"
        title={visible ? "숨기기" : "보기"}
      >
        {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: SettingField;
  value: string;
  onChange: (v: string) => void;
}) {
  const disabled = field.read_only;

  if (field.value_type === "bool") {
    const boolVal = value === "true" || value === "True" || value === "1";
    return (
      <BoolToggle
        value={boolVal}
        onChange={(v) => onChange(v ? "true" : "false")}
        disabled={disabled}
      />
    );
  }

  if (field.sensitive) {
    return (
      <SensitiveInput value={value} onChange={onChange} disabled={disabled} />
    );
  }

  const inputType =
    field.value_type === "int" || field.value_type === "float"
      ? "number"
      : "text";

  return (
    <input
      type={inputType}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      step={field.value_type === "float" ? "0.1" : undefined}
      className={cn(
        "w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground",
        "focus:outline-none focus:ring-1 focus:ring-ring",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    />
  );
}

export function SettingFieldWidget({
  field,
  value,
  onChange,
}: {
  field: SettingField;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[1fr_1.2fr] gap-2 items-start px-1 py-1.5 rounded",
        field.read_only && "opacity-60",
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium text-foreground truncate">
            {field.label}
          </span>
          {!field.hot_reloadable && !field.read_only && (
            <span
              title="재시작 후 적용"
              className="shrink-0 text-muted-foreground"
            >
              <RotateCcw className="h-3 w-3" />
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {field.description}
        </p>
      </div>
      <FieldInput field={field} value={value} onChange={onChange} />
    </div>
  );
}
