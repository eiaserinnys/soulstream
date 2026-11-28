import { intlLocale, resolveLanguage } from "@soulstream/i18n";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { Button, Input } from "@seosoyoung/soul-ui";
import type { McpSecret } from "../../lib/mcp-api";
import {
  SettingsDetailHeader,
  SettingsField,
  SettingsGroupBox,
} from "../config/SettingsListDetail";

export function McpSecretEditor({
  secret,
  busy,
  onEdit,
  replace,
  remove,
}: {
  secret: McpSecret;
  busy: boolean;
  onEdit(): void;
  replace(name: string, value: string): Promise<boolean>;
  remove(secret: McpSecret): void;
}) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const replaceButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setEditing(false);
    setValue("");
  }, [secret.name, secret.updated_at]);
  return (
    <div
      className="space-y-4"
      onKeyDown={(event) => {
        if (event.key === "Escape" && editing) {
          event.stopPropagation();
          setEditing(false);
          setValue("");
          replaceButton.current?.focus();
        }
      }}
    >
      <SettingsDetailHeader
        title={secret.name}
        subtitle={t("mcp.storedInDb")}
        selectableTitle
        actions={
          <Button
            type="button"
            variant="destructive-outline"
            onClick={() => remove(secret)}
          >
            {t("mcp.delete")}
          </Button>
        }
      />
      <SettingsGroupBox title={t("mcp.usage")}>
        <div className="space-y-2 text-sm">
          <p data-v3-selectable-content="true">
            {t("mcp.updatedAt", { date: secret.updated_at ? new Date(secret.updated_at).toLocaleString(intlLocale(resolveLanguage(i18n.resolvedLanguage, []))) : t("mcp.unknown") })}
          </p>
          {secret.servers.length || secret.profiles.length ? (
            <>
              <p data-v3-selectable-content="true">{t("mcp.usageServers", { servers: secret.servers.join(", ") || t("mcp.none") })}</p>
              <p data-v3-selectable-content="true">{t("mcp.usageProfiles", { profiles: secret.profiles.join(", ") || t("mcp.none") })}</p>
            </>
          ) : (
            <p>{t("mcp.unused")}</p>
          )}
        </div>
      </SettingsGroupBox>
      <Button
        ref={replaceButton}
        type="button"
        variant="outline"
        aria-expanded={editing}
        onClick={() => {
          setEditing(!editing);
          setValue("");
        }}
      >
        {t("mcp.replaceValue")}
      </Button>
      {editing ? (
        <SettingsGroupBox title={t("mcp.replaceValue")}>
          <div className="space-y-2">
            <SettingsField label={t("mcp.newValue")}>
              <Input
                type="password"
                autoFocus
                autoComplete="off"
                value={value}
                onChange={(event) => { setValue(event.target.value); onEdit(); }}
              />
            </SettingsField>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditing(false);
                  setValue("");
                  replaceButton.current?.focus();
                }}
              >
                {t("mcp.cancel")}
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void replace(secret.name, value).then((ok) => {
                    if (ok) {
                      setValue("");
                      setEditing(false);
                      replaceButton.current?.focus();
                    }
                  })
                }
              >
                {t("mcp.save")}
              </Button>
            </div>
          </div>
        </SettingsGroupBox>
      ) : null}
    </div>
  );
}
