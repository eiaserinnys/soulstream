/**
 * ConfigModal - 서버 설정 편집 모달
 *
 * GET /api/config/settings로 설정을 조회하고,
 * PUT /api/config/settings로 변경분만 저장합니다.
 * 카테고리별 그룹핑, 타입별 입력 위젯, sensitive 마스킹,
 * read_only disabled, hot_reloadable 구분을 제공합니다.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  Button,
  cn,
} from "@seosoyoung/soul-ui";
import { Eye, EyeOff, RotateCcw } from "lucide-react";

// === Types ===

interface SettingField {
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

interface SettingCategory {
  name: string;
  label: string;
  fields: SettingField[];
}

interface ConfigResponse {
  serendipityAvailable: boolean;
  categories: SettingCategory[];
}

interface SaveResponse {
  applied: string[];
  restart_required: string[];
  errors: string[];
}

interface ConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// === API helpers ===

async function fetchSettings(): Promise<ConfigResponse> {
  const res = await fetch("/api/config/settings");
  if (!res.ok) throw new Error("Failed to fetch settings");
  return res.json();
}

async function saveSettings(
  changes: Record<string, string>,
): Promise<SaveResponse> {
  const res = await fetch("/api/config/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changes }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg =
      body?.detail?.errors?.join(", ") ??
      body?.detail ??
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res.json();
}

// === Field input components ===

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

// === Category section ===

function CategorySection({
  category,
  formData,
  onChange,
}: {
  category: SettingCategory;
  formData: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="mb-4 last:mb-0">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 px-1">
        {category.label}
      </h3>
      <div className="space-y-2">
        {category.fields.map((field) => (
          <div
            key={field.key}
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
              <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                {field.description}
              </p>
            </div>
            <FieldInput
              field={field}
              value={formData[field.key] ?? ""}
              onChange={(v) => onChange(field.key, v)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// === Result message ===

function ResultMessage({
  result,
}: {
  result: { applied: string[]; restart_required: string[]; errors: string[] } | null;
}) {
  if (!result) return null;

  return (
    <div className="text-xs space-y-1 mb-2">
      {result.applied.length > 0 && (
        <p className="text-success">
          ✅ {result.applied.length}개 설정 적용됨
        </p>
      )}
      {result.restart_required.length > 0 && (
        <p className="text-accent-amber">
          🔄 {result.restart_required.length}개 설정은 서버 재시작 후
          적용됩니다
        </p>
      )}
      {result.errors.length > 0 && (
        <p className="text-accent-red">
          ❌ {result.errors.join(", ")}
        </p>
      )}
    </div>
  );
}

// === Main Modal ===

export function ConfigModal({ open, onOpenChange }: ConfigModalProps) {
  const [categories, setCategories] = useState<SettingCategory[]>([]);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [originalData, setOriginalData] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SaveResponse | null>(null);

  // Fetch settings when modal opens
  useEffect(() => {
    if (!open) return;

    setLoading(true);
    setError(null);
    setResult(null);

    fetchSettings()
      .then((data) => {
        setCategories(data.categories);

        const initial: Record<string, string> = {};
        for (const cat of data.categories) {
          for (const field of cat.fields) {
            initial[field.key] = String(field.value ?? "");
          }
        }
        setFormData(initial);
        setOriginalData(initial);
      })
      .catch((err) => {
        setError(err.message);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open]);

  const handleChange = useCallback((key: string, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    setResult(null);
  }, []);

  // Collect changed fields
  const changedKeys = Object.keys(formData).filter(
    (key) => formData[key] !== originalData[key],
  );
  const hasChanges = changedKeys.length > 0;

  const handleSave = useCallback(async () => {
    const changes: Record<string, string> = {};
    for (const key of changedKeys) {
      changes[key] = formData[key];
    }

    setSaving(true);
    setError(null);
    setResult(null);

    try {
      const res = await saveSettings(changes);
      setResult(res);

      // Update originalData for successfully applied + restart_required fields
      const savedKeys = new Set([...res.applied, ...res.restart_required]);
      setOriginalData((prev) => {
        const next = { ...prev };
        for (const key of savedKeys) {
          next[key] = formData[key];
        }
        return next;
      });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }, [changedKeys, formData]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>⚙️ 서버 설정</DialogTitle>
          <DialogDescription>
            .env 환경변수를 편집합니다. 🔄 표시된 항목은 서버 재시작 후
            적용됩니다.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          {loading && (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
              설정을 불러오는 중...
            </div>
          )}

          {error && !loading && (
            <div className="text-accent-red text-sm py-4 text-center">
              ❌ {error}
            </div>
          )}

          {!loading && !error && categories.length > 0 && (
            <div className="divide-y divide-border">
              {categories.map((cat) => (
                <div key={cat.name} className="py-3 first:pt-0 last:pb-0">
                  <CategorySection
                    category={cat}
                    formData={formData}
                    onChange={handleChange}
                  />
                </div>
              ))}
            </div>
          )}
        </DialogPanel>

        <DialogFooter>
          <div className="flex flex-col w-full gap-2">
            <ResultMessage result={result} />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                닫기
              </Button>
              <Button
                size="sm"
                disabled={!hasChanges || saving}
                onClick={handleSave}
              >
                {saving ? "저장 중..." : `저장${hasChanges ? ` (${changedKeys.length})` : ""}`}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
