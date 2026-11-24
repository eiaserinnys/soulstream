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
        subtitle="DB에 저장됨"
        selectableTitle
        actions={
          <Button
            type="button"
            variant="destructive-outline"
            onClick={() => remove(secret)}
          >
            삭제
          </Button>
        }
      />
      <SettingsGroupBox title="사용처">
        <div className="space-y-2 text-sm">
          <p data-v3-selectable-content="true">
            갱신:{" "}
            {secret.updated_at
              ? new Date(secret.updated_at).toLocaleString("ko-KR")
              : "알 수 없음"}
          </p>
          {secret.servers.length || secret.profiles.length ? (
            <>
              <p data-v3-selectable-content="true">서버: {secret.servers.join(", ") || "없음"}</p>
              <p data-v3-selectable-content="true">프로필: {secret.profiles.join(", ") || "없음"}</p>
            </>
          ) : (
            <p>사용처 없음</p>
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
        값 교체
      </Button>
      {editing ? (
        <SettingsGroupBox title="값 교체">
          <div className="space-y-2">
            <SettingsField label="새 값">
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
                취소
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
                저장
              </Button>
            </div>
          </div>
        </SettingsGroupBox>
      ) : null}
    </div>
  );
}
