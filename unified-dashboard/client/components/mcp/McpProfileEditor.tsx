import { useEffect, useState } from "react";
import { Button, Checkbox, Input } from "@seosoyoung/soul-ui";
import type { McpConfig, McpProfile } from "../../lib/mcp-api";
import {
  SettingsAlert,
  SettingsDetailHeader,
  SettingsField,
  SettingsGroupBox,
} from "../config/SettingsListDetail";
import { McpIconTile, McpServerIcons } from "./McpIcons";

export function McpProfileEditor({
  profile,
  config,
  busy,
  save,
  remove,
  rollback,
}: {
  profile: McpProfile | null;
  config: McpConfig;
  busy: boolean;
  save(
    id: string,
    input: {
      name: string;
      description: string;
      mcp_servers: string[];
      hosted_tools: unknown[];
      expected_version?: number;
      expected_revision?: number;
    },
  ): Promise<unknown>;
  remove(profile: McpProfile): void;
  rollback(profile: McpProfile): void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [servers, setServers] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    setId(profile?.id ?? "");
    setName(profile?.name ?? "");
    setDescription(profile?.description ?? "");
    setServers(profile?.mcp_servers ?? []);
    setError("");
  }, [profile?.id, profile?.version]);
  const bindings = config.bindings.filter(
    (binding) => binding.mcp_profile_id === profile?.id,
  );
  return (
    <div className="space-y-4">
      <SettingsDetailHeader
        title={profile?.name || profile?.id || "새 프로필"}
        subtitle={profile ? `판 ${profile.version}` : undefined}
        actions={
          profile ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => rollback(profile)}
              >
                되돌리기
              </Button>
              <Button
                type="button"
                variant="destructive-outline"
                onClick={() => remove(profile)}
              >
                삭제
              </Button>
            </>
          ) : null
        }
      />
      <SettingsGroupBox title="프로필">
        <div className="space-y-3">
          <SettingsField label="프로필 ID">
            <Input
              value={id}
              disabled={Boolean(profile)}
              onChange={(event) => setId(event.target.value)}
            />
          </SettingsField>
          <SettingsField label="이름">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </SettingsField>
          <SettingsField label="설명">
            <Input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </SettingsField>
          <McpServerIcons
            ids={servers}
            servers={config.servers}
            limit={servers.length}
          />
        </div>
      </SettingsGroupBox>
      <SettingsGroupBox title="서버">
        <div className="grid gap-2 sm:grid-cols-2">
          {config.servers.map((server) => (
            <label key={server.id} className="flex min-w-0 items-center gap-2">
              <Checkbox
                checked={servers.includes(server.id)}
                onCheckedChange={(checked) =>
                  setServers((current) =>
                    checked
                      ? [...current, server.id]
                      : current.filter((id) => id !== server.id),
                  )
                }
              />
              <McpIconTile id={server.id} icon={server.icon} />
              <span className="truncate">{server.name || server.id}</span>
            </label>
          ))}
        </div>
      </SettingsGroupBox>
      {profile ? (
        <SettingsGroupBox title="소속과 연결">
          <div className="space-y-2 text-sm">
            <p data-v3-selectable-content="true">
              소속 노드:{" "}
              {profile.node_scope.length
                ? profile.node_scope.join(", ")
                : "소속 노드 없음"}
            </p>
            <p data-v3-selectable-content="true">
              연결된 에이전트:{" "}
              {bindings.length
                ? bindings
                    .map(
                      (binding) => `${binding.agent_id} (${binding.node_id})`,
                    )
                    .join(", ")
                : "없음"}
            </p>
          </div>
        </SettingsGroupBox>
      ) : null}
      {error ? <SettingsAlert scrollIntoView>{error}</SettingsAlert> : null}
      <div className="flex justify-end">
        <Button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!id.trim()) {
              setError("프로필 ID를 입력해 주세요.");
              return;
            }
            if (!profile && config.profiles.some((item) => item.id === id)) {
              setError("이미 사용 중인 프로필 ID입니다.");
              return;
            }
            setError("");
            void save(id, {
              name,
              description,
              mcp_servers: servers,
              hosted_tools: profile?.hosted_tools ?? [],
              ...(profile
                ? { expected_version: profile.version }
                : { expected_revision: config.current_revision }),
            });
          }}
        >
          저장
        </Button>
      </div>
    </div>
  );
}
