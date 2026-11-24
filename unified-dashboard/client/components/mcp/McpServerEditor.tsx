import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Input } from "@seosoyoung/soul-ui";
import type {
  Definition,
  McpConfig,
  McpIcon,
  McpProfile,
  McpServer,
  McpTestInput,
  McpTestResult,
} from "../../lib/mcp-api";
import {
  SettingsAlert,
  SettingsDetailHeader,
  SettingsField,
  SettingsGroupBox,
} from "../config/SettingsListDetail";
import { DefinitionEditor } from "./DefinitionEditor";
import { McpIconPicker, McpIconTile, McpServerIcons } from "./McpIcons";
import {
  readDefinition,
  pendingSecrets,
  validateUnits,
  writeDefinition,
  type DefinitionDraft,
} from "./definition";

type Props = {
  server: McpServer | null;
  config: McpConfig;
  busy: boolean;
  onEdit(): void;
  save(
    id: string,
    input: {
      definition: Definition;
      scope: string[];
      overrides: Record<string, Definition>;
      icon: McpIcon | null;
      secrets: Record<string, string>;
    },
    version?: number,
  ): Promise<unknown>;
  remove(server: McpServer): void;
  rollback(server: McpServer): void;
  upload(file: File): Promise<McpIcon>;
  addToProfiles(serverId: string, profiles: McpProfile[]): Promise<boolean>;
  justCreated: boolean;
  dismissCreated(): void;
  test?(input: McpTestInput): Promise<McpTestResult>;
};
const empty = (): DefinitionDraft =>
  readDefinition({ type: "streamable_http", config: { url: "" } });

export function McpServerEditor({
  server,
  config,
  busy,
  onEdit,
  save,
  remove,
  rollback,
  upload,
  addToProfiles,
  justCreated,
  dismissCreated,
  test,
}: Props) {
  const [id, setId] = useState(server?.id ?? "");
  const [draft, setDraft] = useState<DefinitionDraft>(() =>
    server
      ? readDefinition({ ...server, name: server.name ?? undefined })
      : empty(),
  );
  const [scope, setScope] = useState<string[]>(
    server?.node_scope ?? config.managed_nodes.map((node) => node.node_id),
  );
  const [overrides, setOverrides] = useState<Record<string, DefinitionDraft>>(
    () =>
      Object.fromEntries(
        Object.entries(server?.node_overrides ?? {}).map(([key, value]) => [
          key,
          readDefinition(value),
        ]),
      ),
  );
  const [icon, setIcon] = useState<McpIcon | null>(server?.icon ?? null);
  const [secrets, setSecrets] = useState<
    Record<string, { name: string; value: string }>
  >({});
  const [formError, setFormError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [testNode, setTestNode] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [testError, setTestError] = useState("");
  const [picker, setPicker] = useState(false);
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([]);
  const createdPrompt = useRef<HTMLDivElement>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (justCreated) createdPrompt.current?.focus();
  }, [justCreated]);
  useEffect(() => {
    setId(server?.id ?? "");
    setDraft(
      server
        ? readDefinition({ ...server, name: server.name ?? undefined })
        : empty(),
    );
    setScope(
      server?.node_scope ?? config.managed_nodes.map((node) => node.node_id),
    );
    setOverrides(
      Object.fromEntries(
        Object.entries(server?.node_overrides ?? {}).map(([key, value]) => [
          key,
          readDefinition(value),
        ]),
      ),
    );
    setIcon(server?.icon ?? null);
    setSecrets({});
    setFormError("");
    setDirty(false);
    setTestResult(null);
    setTestError("");
    setPicker(false);
    setSelectedProfiles([]);
  }, [
    server?.id,
    server?.version,
    config.managed_nodes.map((node) => node.node_id).join("\u0000"),
  ]);
  const testNodes = config.managed_nodes.filter(node => !server || scope.includes(node.node_id));
  useEffect(() => {
    if (!testNodes.some(node => node.node_id === testNode)) setTestNode(testNodes[0]?.node_id ?? "");
  }, [testNodes.map(node => node.node_id).join("|"), testNode]);
  const markEdit = () => { setDirty(true); setTestResult(null); setTestError(""); onEdit(); };
  const setSecret = (unitId: string, name: string, value: string | null) => {
    markEdit();
    setSecrets((current) => {
      const next = { ...current };
      if (value === null) delete next[unitId];
      else next[unitId] = { name, value };
      return next;
    });
  };
  const users = config.profiles.filter((profile) =>
    profile.mcp_servers.includes(server?.id ?? ""),
  );
  const secretNames = config.secrets.map((secret) => secret.name);
  const runTest = async () => {
    if (!test || !testNode) return;
    const pending = pendingSecrets([draft, ...Object.values(overrides)], secrets);
    const clean = (value: string) => Object.values(pending).filter(Boolean).reduce((text, secret) => text.split(secret).join("[비공개]"), value);
    const issue = validateUnits([draft, ...Object.values(overrides)], secretNames, pending);
    if (issue) { setTestError(issue); return; }
    setTesting(true); setTestError(""); setTestResult(null);
    try {
      const result = await test(server && !dirty ? { node_id: testNode, server_id: server.id } : {
        node_id: testNode, draft_server: { id: id.trim() || "draft", ...writeDefinition(draft), node_scope: scope,
          node_overrides: Object.fromEntries(Object.entries(overrides).map(([node, value]) => [node, writeDefinition(value)])) },
        ...(Object.keys(pending).length ? { inline_secrets: pending } : {}),
      });
      setTestResult(result.ok ? { ...result, tools: result.tools.map(clean), ...(result.server_info ? { server_info: { name: clean(result.server_info.name), version: clean(result.server_info.version) } } : {}) }
        : { ...result, error_message: clean(result.error_message) });
    } catch (caught) { setTestError(clean(caught instanceof Error ? caught.message : "연결 시험에 실패했습니다.")); }
    finally { setTesting(false); }
  };
  return (
    <div className="space-y-4">
      <SettingsDetailHeader
        title={server?.name || server?.id || "새 서버"}
        subtitle={server ? `${server.type} / 판 ${server.version}` : undefined}
        leadingIcon={<McpIconTile id={id || "M"} icon={icon} />}
        actions={
          <>
          {test ? <><label className="flex items-center gap-2 text-sm">시험 노드<select aria-label="시험 노드" className="rounded-floor border border-border bg-background p-2" value={testNode} onChange={event => { setTestNode(event.target.value); setTestResult(null); }}><option value="" disabled>노드 선택</option>{testNodes.map(node => <option key={node.node_id} value={node.node_id}>{node.node_id}</option>)}</select></label><Button type="button" variant="outline" disabled={busy || testing || !testNode} onClick={() => void runTest()}>{testing ? "시험 중…" : "연결 시험"}</Button></> : null}
          {server ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => rollback(server)}
              >
                되돌리기
              </Button>
              <Button
                type="button"
                variant="destructive-outline"
                onClick={() => remove(server)}
              >
                삭제
              </Button>
            </>
          ) : null}
          </>
        }
      />
      {testing ? <p role="status" className="text-sm text-muted-foreground">연결을 시험하는 중…</p> : null}
      {testError ? <SettingsAlert>{testError}</SettingsAlert> : null}
      {testResult ? <SettingsGroupBox title="연결 시험 결과">{testResult.ok ? <div className="space-y-2 text-sm"><p>성공 · {testResult.latency_ms}ms{testResult.server_info ? ` · ${testResult.server_info.name} ${testResult.server_info.version}` : ""}</p><p>도구 {testResult.tool_count}개{testResult.tool_count > testResult.tools.length ? ` · 외 ${testResult.tool_count - testResult.tools.length}개` : ""}</p>{testResult.tools.length > 10 ? <details className="config-advanced"><summary>도구 이름 보기</summary><p className="break-words">{testResult.tools.join(", ")}</p></details> : <p className="break-words">{testResult.tools.join(", ")}</p>}</div> : <p className="text-sm">{{ config: "설정", connect: "연결", initialize: "초기화", list_tools: "도구 목록", timeout: "시간 초과" }[testResult.error_stage]}: {testResult.error_message}</p>}</SettingsGroupBox> : null}
      {justCreated && server ? (
        <div
          ref={createdPrompt}
          tabIndex={-1}
          className="rounded-floor focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SettingsGroupBox title="어느 프로필에 바로 추가할까요?">
            <div className="space-y-2">
              {config.profiles.map((profile) => (
                <label
                  key={profile.id}
                  className="flex items-center justify-between gap-2 rounded-floor border border-border p-2"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Checkbox
                      checked={selectedProfiles.includes(profile.id)}
                      onCheckedChange={(checked) =>
                        setSelectedProfiles((current) =>
                          checked
                            ? [...current, profile.id]
                            : current.filter((id) => id !== profile.id),
                        )
                      }
                    />
                    <span className="truncate">
                      {profile.name || profile.id}
                    </span>
                  </span>
                  <McpServerIcons
                    ids={profile.mcp_servers}
                    servers={config.servers}
                  />
                </label>
              ))}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    dismissCreated();
                    pickerButton.current?.focus();
                  }}
                >
                  나중에
                </Button>
                <Button
                  type="button"
                  disabled={busy || !selectedProfiles.length}
                  onClick={() =>
                    void addToProfiles(
                      server.id,
                      config.profiles.filter((p) =>
                        selectedProfiles.includes(p.id),
                      ),
                    ).then((ok) => {
                      if (ok) pickerButton.current?.focus();
                    })
                  }
                >
                  선택한 프로필에 추가
                </Button>
              </div>
            </div>
          </SettingsGroupBox>
        </div>
      ) : null}
      <SettingsGroupBox title="기본 정보 및 아이콘">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <SettingsField label="서버 ID">
              <Input
                value={id}
                disabled={Boolean(server)}
                onChange={(event) => { setId(event.target.value); markEdit(); }}
              />
            </SettingsField>
            <SettingsField label="전송 이름">
              <Input
                value={draft.name}
                onChange={(event) => { setDraft({ ...draft, name: event.target.value }); markEdit(); }}
              />
            </SettingsField>
          </div>
          <Button
            ref={pickerButton}
            type="button"
            variant="outline"
            aria-expanded={picker}
            onClick={() => setPicker(!picker)}
          >
            아이콘 고르기
          </Button>
          {picker ? (
            <div
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setPicker(false);
                  pickerButton.current?.focus();
                }
              }}
            >
              <McpIconPicker
                id={id}
                name={draft.name}
                url={draft.url}
                value={icon}
                onChange={(value) => { setIcon(value); markEdit(); }}
                upload={upload}
              />
            </div>
          ) : null}
        </div>
      </SettingsGroupBox>
      <DefinitionEditor
        value={draft}
        secretNames={secretNames}
        onChange={(value) => { setDraft(value); markEdit(); }}
        onSecretValue={setSecret}
      />
      <SettingsGroupBox title="적용 노드 및 덮어쓰기">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-3">
            {config.managed_nodes.map((node) => (
              <label
                key={node.node_id}
                className="flex items-center gap-2 text-sm"
              >
                <Checkbox
                  checked={scope.includes(node.node_id)}
                  onCheckedChange={(checked) => {
                    markEdit();
                    setScope((current) =>
                      checked
                        ? [...current, node.node_id]
                        : current.filter((id) => id !== node.node_id),
                    );
                    if (!checked)
                      setOverrides((current) => {
                        const next = { ...current };
                        delete next[node.node_id];
                        return next;
                      });
                  }}
                />
                {node.node_id}
              </label>
            ))}
          </div>
          <details className="config-advanced">
            <summary>노드별 덮어쓰기 <span data-v3-selectable-content="true">{Object.keys(overrides).join(", ") || "없음"}</span></summary>
            <div className="space-y-3 pt-3">
              {scope.map((node) => (
                <div key={node} className="space-y-2">
                  <label className="flex items-center gap-2 break-keep">
                    <Checkbox
                      checked={Boolean(overrides[node])}
                      onCheckedChange={(checked) => {
                        markEdit();
                        setOverrides((current) => {
                          const next = { ...current };
                          if (checked)
                            next[node] = readDefinition(writeDefinition(draft));
                          else delete next[node];
                          return next;
                        });
                      }}
                    />
                    {node} · 이 노드는 다른 정의
                  </label>
                  {overrides[node] ? (
                    <DefinitionEditor
                      value={overrides[node]}
                      secretNames={secretNames}
                      isolateValue
                      onChange={(value) => {
                        markEdit();
                        setOverrides((current) => ({
                          ...current,
                          [node]: value,
                        }));
                      }}
                      onSecretValue={setSecret}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          </details>
          {server ? <details className="config-advanced"><summary>사용 프로필 <span>{users.length}개</span></summary><p data-v3-selectable-content="true" className="break-keep text-sm text-muted-foreground">{users.length ? users.map((p) => p.name || p.id).join(", ") : "없음"}</p></details> : null}
          {formError ? (
            <SettingsAlert scrollIntoView>{formError}</SettingsAlert>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                const pending = pendingSecrets(
                  [draft, ...Object.values(overrides)],
                  secrets,
                );
                const issue = !id.trim()
                  ? "서버 ID를 입력해 주세요."
                  : !server && config.servers.some((item) => item.id === id)
                    ? "이미 사용 중인 서버 ID입니다."
                    : validateUnits(
                        [draft, ...Object.values(overrides)],
                        secretNames,
                        pending,
                      );
                if (issue) {
                  setFormError(issue);
                  return;
                }
                setFormError("");
                void save(
                  id,
                  {
                    definition: writeDefinition(draft),
                    scope,
                    overrides: Object.fromEntries(
                      Object.entries(overrides).map(([node, value]) => [
                        node,
                        writeDefinition(value),
                      ]),
                    ),
                    icon,
                    secrets: pending,
                  },
                  server?.version,
                );
              }}
            >
              저장
            </Button>
          </div>
        </div>
      </SettingsGroupBox>
    </div>
  );
}
