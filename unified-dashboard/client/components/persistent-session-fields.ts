import type { useTranslation } from "react-i18next";
import type { PersistentSession } from "../lib/persistent-sessions";
import type { SettingField } from "./config/SettingFieldWidget";

export function textField(key: string, label: string, value: string, readOnly: boolean, description = ""): SettingField {
  return { key, field_name: key, label, description, value, value_type: "str", sensitive: false, hot_reloadable: true, read_only: readOnly };
}

type Translate = ReturnType<typeof useTranslation>["t"];

export function agentLabel(session: PersistentSession, t: Translate): string {
  return session.agent_name ?? session.agent_id ?? t("jobs.persistent.unknownAgent");
}

export function currentModelText(session: PersistentSession, t: Translate): string {
  const { model_preset, model, reasoning_effort } = session.runtime.current_model;
  const parts = [model ?? model_preset, reasoning_effort].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : t("jobs.persistent.unknownModel");
}
