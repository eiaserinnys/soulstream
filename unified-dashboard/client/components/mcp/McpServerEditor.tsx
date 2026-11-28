import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Input } from "@seosoyoung/soul-ui";
import {
  mcpRequestErrorText,
  type Definition,
  type McpConfig,
  type McpIcon,
  type McpProfile,
  type McpServer,
  type McpTestInput,
  type McpTestResult,
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
  const { t } = useTranslation();
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
    const clean = (value: string) => Object.values(pending).filter(Boolean).reduce((text, secret) => text.split(secret).join(t("mcp.redacted")), value);
    const issue = validateUnits([draft, ...Object.values(overrides)], secretNames, pending, t);
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
    } catch (caught) { setTestError(clean(mcpRequestErrorText(caught, t))); }
    finally { setTesting(false); }
  };
  return (
    <div className="space-y-4">
      <SettingsDetailHeader
        title={server?.name || server?.id || t("mcp.newServer")}
        subtitle={server ? t("mcp.serverVersion", { transport: server.type, revision: server.version }) : undefined}
        leadingIcon={<McpIconTile id={id || "M"} icon={icon} />}
        actions={
          <>
          {test ? <><label className="flex items-center gap-2 text-sm">{t("mcp.testNode")}<select aria-label={t("mcp.testNode")} className="h-9 rounded-floor border border-border bg-background px-2 sm:h-8" value={testNode} onChange={event => { setTestNode(event.target.value); setTestResult(null); }}><option value="" disabled>{t("mcp.selectNode")}</option>{testNodes.map(node => <option key={node.node_id} value={node.node_id}>{node.node_id}</option>)}</select></label><Button type="button" variant="outline" disabled={busy || testing || !testNode} onClick={() => void runTest()}>{testing ? t("mcp.testing") : t("mcp.testConnection")}</Button></> : null}
          {server ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => rollback(server)}
              >
                {t("mcp.rollback")}
              </Button>
              <Button
                type="button"
                variant="destructive-outline"
                onClick={() => remove(server)}
              >
                {t("mcp.delete")}
              </Button>
            </>
          ) : null}
          </>
        }
      />
      {testing ? <p role="status" className="text-sm text-muted-foreground">{t("mcp.testingConnection")}</p> : null}
      {testError ? <SettingsAlert>{testError}</SettingsAlert> : null}
      {testResult ? <SettingsGroupBox title={t("mcp.testResult")}>{testResult.ok ? <div className="space-y-2 text-sm"><p data-v3-selectable-content="true">{t("mcp.testSuccess", { latency: testResult.latency_ms })}{testResult.server_info ? ` · ${testResult.server_info.name} ${testResult.server_info.version}` : ""}</p><p data-v3-selectable-content="true">{t("mcp.toolCount", { count: testResult.tool_count })}</p>{testResult.tools.length > 10 ? <details className="config-advanced"><summary>{t("mcp.showTools")}</summary><p className="break-words" data-v3-selectable-content="true">{testResult.tools.join(", ")}{testResult.tool_count > testResult.tools.length ? " " + t("mcp.remainingCount", { count: testResult.tool_count - testResult.tools.length }) : ""}</p></details> : <p className="break-words" data-v3-selectable-content="true">{testResult.tools.join(", ")}{testResult.tool_count > testResult.tools.length ? " " + t("mcp.remainingCount", { count: testResult.tool_count - testResult.tools.length }) : ""}</p>}</div> : <div className="space-y-1" data-v3-selectable-content="true"><p className="text-sm">{{ config: t("mcp.testConfigError"), connect: t("mcp.testConnectError"), initialize: t("mcp.testInitializeError"), list_tools: t("mcp.testListToolsError"), timeout: t("mcp.testTimeout") }[testResult.error_stage]}</p>{testResult.error_message !== `MCP ${testResult.error_stage} failed` ? <p className="break-words text-xs text-muted-foreground">{testResult.error_message}</p> : null}</div>}</SettingsGroupBox> : null}
      {justCreated && server ? (
        <div
          ref={createdPrompt}
          tabIndex={-1}
          className="rounded-floor focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SettingsGroupBox title={t("mcp.chooseProfiles")}>
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
                  {t("mcp.later")}
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
                  {t("mcp.addToSelectedProfiles")}
                </Button>
              </div>
            </div>
          </SettingsGroupBox>
        </div>
      ) : null}
      <SettingsGroupBox title={t("mcp.detailsAndIcon")}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <SettingsField label={t("mcp.serverId")}>
              <Input
                value={id}
                disabled={Boolean(server)}
                onChange={(event) => { setId(event.target.value); markEdit(); }}
              />
            </SettingsField>
            <SettingsField label={t("mcp.transportName")}>
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
            {t("mcp.chooseIcon")}
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
      <SettingsGroupBox title={t("mcp.nodesAndOverrides")}>
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
            <summary>{t("mcp.nodeOverrides")} <span data-v3-selectable-content="true">{Object.keys(overrides).join(", ") || t("mcp.none")}</span></summary>
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
                    {t("mcp.differentNodeDefinition", { node })}
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
          {server ? <details className="config-advanced"><summary>{t("mcp.usingProfiles")} <span>{t("mcp.itemCount", { count: users.length })}</span></summary><p data-v3-selectable-content="true" className="break-keep text-sm text-muted-foreground">{users.length ? users.map((p) => p.name || p.id).join(", ") : t("mcp.none")}</p></details> : null}
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
                  ? t("mcp.serverIdRequired")
                  : !server && config.servers.some((item) => item.id === id)
                    ? t("mcp.serverIdTaken")
                    : validateUnits(
                        [draft, ...Object.values(overrides)],
                        secretNames,
                        pending,
                        t,
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
              {t("mcp.save")}
            </Button>
          </div>
        </div>
      </SettingsGroupBox>
    </div>
  );
}
