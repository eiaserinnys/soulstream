/**
 * useConfigSettings — 서버 설정 조회/저장 훅
 *
 * GET  /api/config/settings 로 카테고리별 설정을 조회하고,
 * PUT  /api/config/settings 로 변경분만 저장한다.
 *
 * 원본 값(originalData)을 기준으로 dirty 키를 계산하며,
 * 저장 성공 시 applied + restart_required 키에 대해 origin을 갱신한다.
 */

import { useCallback, useEffect, useState } from "react";
import type { SettingField } from "../components/config/SettingFieldWidget";

export interface SettingCategory {
  name: string;
  label: string;
  fields: SettingField[];
}

interface ConfigResponse {
  categories: SettingCategory[];
  // serendipityAvailable 등 기타 필드는 unified-dashboard에서 무시
  [key: string]: unknown;
}

export interface SaveResponse {
  applied: string[];
  restart_required: string[];
  errors: string[];
}

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

function normalizeFieldValue(field: SettingField): string {
  let v = String(field.value ?? "");
  if (field.value_type === "bool") {
    v = (v === "true" || v === "True" || v === "1") ? "true" : "false";
  }
  return v;
}

export interface UseConfigSettingsResult {
  categories: SettingCategory[];
  formData: Record<string, string>;
  loading: boolean;
  saving: boolean;
  error: string | null;
  result: SaveResponse | null;
  changedKeys: string[];
  hasChanges: boolean;
  updateField: (key: string, value: string) => void;
  save: () => Promise<void>;
}

/**
 * modal이 열렸을 때 설정을 조회하고, 저장/변경 관리를 담당한다.
 * enabled=false면 네트워크 요청을 보내지 않고 상태만 초기화 상태로 유지한다.
 */
export function useConfigSettings(enabled: boolean): UseConfigSettingsResult {
  const [categories, setCategories] = useState<SettingCategory[]>([]);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [originalData, setOriginalData] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SaveResponse | null>(null);

  useEffect(() => {
    if (!enabled) return;

    setLoading(true);
    setError(null);
    setResult(null);

    fetchSettings()
      .then((data) => {
        setCategories(data.categories);

        const initial: Record<string, string> = {};
        for (const cat of data.categories) {
          for (const field of cat.fields) {
            initial[field.key] = normalizeFieldValue(field);
          }
        }
        setFormData(initial);
        setOriginalData(initial);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [enabled]);

  const updateField = useCallback((key: string, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    setResult(null);
  }, []);

  const changedKeys = Object.keys(formData).filter(
    (key) => formData[key] !== originalData[key],
  );
  const hasChanges = changedKeys.length > 0;

  const save = useCallback(async () => {
    const changes: Record<string, string> = {};
    for (const key of Object.keys(formData)) {
      if (formData[key] !== originalData[key]) {
        changes[key] = formData[key];
      }
    }

    setSaving(true);
    setError(null);
    setResult(null);

    try {
      const res = await saveSettings(changes);
      setResult(res);

      const savedKeys = new Set([...res.applied, ...res.restart_required]);
      setOriginalData((prev) => {
        const next = { ...prev };
        for (const key of savedKeys) {
          next[key] = formData[key];
        }
        return next;
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [formData, originalData]);

  return {
    categories,
    formData,
    loading,
    saving,
    error,
    result,
    changedKeys,
    hasChanges,
    updateField,
    save,
  };
}
