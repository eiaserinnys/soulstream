import { useTranslation } from "react-i18next";
// 기존 설정 탭의 목록·상세와 이동 상태를 함께 유지해 500줄을 넘는다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, FrameLoading } from "@seosoyoung/soul-ui";
import {
  createMcpApi,
  type McpConfig,
  type McpIcon,
  type McpSecret,
} from "../../lib/mcp-api";
import { DetailTabs } from "../../v3/DetailTabs";
import {
  SettingsAlert,
  SettingsListDetailFrame,
  SettingsListHeader,
  SettingsListRow,
  SettingsListSection,
} from "../config/SettingsListDetail";
import { McpIconTile, McpServerIcons } from "./McpIcons";
import { McpServerEditor } from "./McpServerEditor";
import { McpProfileEditor } from "./McpProfileEditor";
import { McpSecretEditor } from "./McpSecretEditor";
import { errorText, PartialProfileSaveError } from "./McpErrors";
import { McpDialogs, type DeleteTarget, type History } from "./McpDialogs";

type Tab = "server" | "profile" | "secret";
export function SuccessMessage({ children }: { children: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { ref.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" }); }, [children]);
  return <p ref={ref} role="status" data-v3-selectable-content="true" className="text-sm text-success-foreground" style={{ wordBreak: "keep-all", overflowWrap: "anywhere" }}>{children}</p>;
}
export function McpSettingsTab({ request, initialProfileId, onOpenAgent }: { request?: typeof fetch; initialProfileId?: string; onOpenAgent?: (agentId: string, nodeId: string) => void }) {
  const { t } = useTranslation();
  const api = useMemo(() => createMcpApi(request), [request]);
  const [config, setConfig] = useState<McpConfig | null>(null);
  const [liveRevision, setLiveRevision] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [messagePlace, setMessagePlace] = useState<"header" | "footer">("footer");
  const [tab, setTab] = useState<Tab>(initialProfileId ? "profile" : "server");
  const [selected, setSelected] = useState<string | null>(initialProfileId ?? null);
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(false);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const profileDetail = useRef<HTMLDivElement>(null);
  const focusedInitialProfile = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const next = await api.config();
      setConfig(next);
      setLiveRevision(next.current_revision);
      setLoadError(false);
      return next;
    } catch {
      setLoadError(true);
      throw new Error();
    }
  }, [api]);
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);
  useEffect(() => {
    if (!config || !initialProfileId || focusedInitialProfile.current) return;
    const id = requestAnimationFrame(() => {
      const header = profileDetail.current?.querySelector("header");
      if (!header) return;
      focusedInitialProfile.current = true;
      header.tabIndex = -1;
      header.style.outline = "none";
      let scrollParent = header.parentElement;
      while (scrollParent && !/(auto|scroll)/.test(getComputedStyle(scrollParent).overflowY)) scrollParent = scrollParent.parentElement;
      const bounds = scrollParent?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      const position = header.getBoundingClientRect();
      if (position.top < bounds.top || position.bottom > bounds.bottom) header.scrollIntoView?.({ block: "start" });
      header.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [config, initialProfileId]);
  useEffect(() => {
    if (!config) return;
    const timer = setTimeout(() => {
      void api
        .config()
        .then((next) => {
          setLiveRevision((current) =>
            Math.max(current ?? 0, next.current_revision),
          );
          setConfig((current) =>
            current
              ? { ...current, managed_nodes: next.managed_nodes }
              : current,
          );
          setLoadError(false);
        })
        .catch(() => setLoadError(true));
    }, 5000);
    return () => clearTimeout(timer);
  }, [config, api]);
  const mutate = async (
    action: () => Promise<void>,
    target: DeleteTarget | null = null,
    successMessage = "",
    place: "header" | "footer" = "footer",
    actionKind: "save" | "delete" | "rollback" = "save",
  ): Promise<boolean> => {
    setBusy(true);
    setError("");
    setSuccess("");
    setMessagePlace(place);
    try {
      await action();
      setSuccess(successMessage);
      return true;
    } catch (caught) {
      setError(errorText(caught, config, target, actionKind));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const chooseTab = (next: Tab) => {
    setTab(next);
    setSelected(null);
    setCreating(false);
    setJustCreated(false);
    setError("");
    setSuccess("");
  };
  if (!config)
    return (
      <div className="space-y-4">
        <div aria-hidden="true" className="flex flex-wrap items-center gap-2 rounded-floor border border-border bg-muted/20 p-3">
          <span className="h-7.5 w-24 rounded-full bg-muted sm:h-7" />
          <span className="h-7.5 w-32 rounded-full bg-muted sm:h-7" />
          <span className="h-7.5 w-44 rounded-full bg-muted sm:h-7" />
          <span className="h-7.5 w-48 rounded-full bg-muted sm:h-7" />
        </div>
        <div className="mcp-tabs">
          <DetailTabs
            id="mcp-tabs"
            label={t("mcp.settings")}
            panelId="mcp-panel"
            tabs={
              [
                ["server", t("mcp.server")],
                ["profile", t("mcp.profile")],
                ["secret", t("mcp.secret")],
              ] as const
            }
            value="server"
            disabled
            onChange={() => undefined}
          />
        </div>
        <SettingsListDetailFrame
          testId="mcp-loading"
          list={
            <>
              <SettingsListHeader title={t("mcp.server")} description="" actions={null} />
            </>
          }
        >
          {loadError ? (
            <>
              <SettingsAlert>{t("mcp.loadFailed")}</SettingsAlert>
              <Button
                type="button"
                onClick={() => void refresh().catch(() => undefined)}
              >
                {t("mcp.retry")}
              </Button>
            </>
          ) : (
            <FrameLoading inline label={t("mcp.loading")} />
          )}
        </SettingsListDetailFrame>
      </div>
    );
  const servers = config.servers;
  const profiles = config.profiles;
  const secrets = config.secrets;
  const currentServer = creating
    ? null
    : (servers.find((item) => item.id === selected) ?? servers[0] ?? null);
  const currentProfile = creating
    ? null
    : (profiles.find((item) => item.id === selected) ?? profiles[0] ?? null);
  const currentSecret =
    secrets.find((item) => item.name === selected) ?? secrets[0] ?? null;
  const openHistory = (target: "server" | "profile", id: string) =>
    void mutate(async () => {
      const result = await api.revisions(target, id);
      setHistory({ target, id, revisions: result.revisions });
    }, null, "", "header");
  const openDelete = (target: DeleteTarget) => {
    setError("");
    setSuccess("");
    setDeleting(target);
  };
  const upload = async (file: File): Promise<McpIcon> => {
    if (
      file.size > 262144 ||
      !["image/png", "image/jpeg", "image/webp"].includes(file.type)
    )
      throw new Error("invalid image");
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const result = await api.uploadIcon(data);
    return { kind: "upload", ...result };
  };
  const list = (
    <>
      <SettingsListHeader
        title={
          tab === "server" ? t("mcp.server") : tab === "profile" ? t("mcp.profile") : t("mcp.secret")
        }
        description=""
        actions={
          tab !== "secret" ? (
            <Button
              type="button"
              data-settings-open-detail
              onClick={() => {
                setCreating(true);
                setSelected(null);
                setJustCreated(false);
                setError("");
                setSuccess("");
              }}
            >
              {tab === "server" ? t("mcp.addServer") : t("mcp.addProfile")}
            </Button>
          ) : null
        }
      />
      <SettingsListSection
        isEmpty={
          tab === "server"
            ? !servers.length
            : tab === "profile"
              ? !profiles.length
              : !secrets.length
        }
        emptyText={t("mcp.emptyList")}
      >
        {tab === "server"
          ? servers.map((server) => (
              <SettingsListRow
                key={server.id}
                title={server.name || server.id}
                meta={server.node_scope.length ? t("mcp.serverNodeCount", { transport: server.type, count: server.node_scope.length }) : server.type}
                badge={server.node_scope.length ? undefined : <Badge variant="warning" size="sm" data-testid="mcp-no-nodes">{t("mcp.noTargetNodes")}</Badge>}
                portrait={<McpIconTile id={server.id} icon={server.icon} />}
                selected={!creating && currentServer?.id === server.id}
                onSelect={() => {
                  setSelected(server.id);
                  setCreating(false);
                  setJustCreated(false);
                  setError("");
                  setSuccess("");
                }}
              />
            ))
          : tab === "profile"
            ? profiles.map((profile) => (
                <SettingsListRow
                  key={profile.id}
                  title={profile.name || profile.id}
                  meta={profile.description || profile.id}
                  footer={
                    <McpServerIcons
                      ids={profile.mcp_servers}
                      servers={servers}
                      singleLine
                    />
                  }
                  selected={!creating && currentProfile?.id === profile.id}
                  onSelect={() => {
                    setSelected(profile.id);
                    setCreating(false);
                    setError("");
                    setSuccess("");
                  }}
                />
              ))
            : secrets.map((secret) => (
                <SettingsListRow
                  key={secret.name}
                  title={secret.name}
                  meta={
                    secret.servers.length ? secret.servers.join(", ") : secret.profiles.length ? secret.profiles.join(", ") : t("mcp.unused")
                  }
                  selected={currentSecret?.name === secret.name}
                  onSelect={() => {
                    setSelected(secret.name);
                    setError("");
                    setSuccess("");
                  }}
                />
              ))}
      </SettingsListSection>
    </>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-floor border border-border bg-muted/20 p-3 text-sm">
        <strong>{t("mcp.storedRevision", { revision: liveRevision ?? config.current_revision })}</strong>
        {config.managed_nodes.map((node) => {
          const revision = node.ack?.revision ?? node.applied_revision;
          const stale = revision < (liveRevision ?? config.current_revision);
          return (
            <span
              key={node.node_id}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1"
            >
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${!node.connected ? "bg-muted-foreground" : stale ? "bg-accent-amber" : "bg-accent-green"}`}
              />
              {node.node_id}{" "}
              {node.connected
                ? stale ? t("mcp.pendingRevision", { revision }) : t("mcp.revision", { revision })
                : t("mcp.offline")}
            </span>
          );
        })}
      </div>
      <div className="mcp-tabs">
        <DetailTabs
          id="mcp-tabs"
          label={t("mcp.settings")}
          panelId="mcp-panel"
          tabs={
            [
              ["server", t("mcp.server")],
              ["profile", t("mcp.profile")],
              ["secret", t("mcp.secret")],
            ] as const
          }
          value={tab}
          onChange={chooseTab}
        />
      </div>
      {loadError ? (
        <SettingsAlert>
          {t("mcp.refreshFailed")}{" "}
          <Button
            type="button"
            variant="outline"
            onClick={() => void refresh().catch(() => undefined)}
          >
            {t("mcp.retry")}
          </Button>
        </SettingsAlert>
      ) : null}
      <div id="mcp-panel" role="tabpanel" aria-labelledby={`mcp-tabs-${tab}`}>
        <SettingsListDetailFrame testId="mcp-settings" list={list}>
          {messagePlace === "header" && !deleting && !history && error ? <SettingsAlert scrollIntoView>{error}</SettingsAlert> : null}
          {messagePlace === "header" && success ? <SuccessMessage>{success}</SuccessMessage> : null}
          {tab === "server" && (currentServer || creating) ? (
            <McpServerEditor
              server={currentServer}
              config={config}
              busy={busy}
              test={api.testMcpServer}
              onEdit={() => setSuccess("")}
              justCreated={justCreated}
              dismissCreated={() => setJustCreated(false)}
              upload={upload}
              remove={(server) =>
                openDelete({
                  kind: "server",
                  id: server.id,
                  version: server.version,
                })
              }
              rollback={(server) => openHistory("server", server.id)}
              save={async (id, input, version) =>
                mutate(async () => {
                  if (!id.trim()) throw new Error("id");
                  await api.putServer(id, {
                    ...input.definition,
                    node_scope: input.scope,
                    node_overrides: input.overrides,
                    icon: input.icon,
                    inline_secrets: input.secrets,
                    ...(version === undefined
                      ? { expected_revision: config.current_revision }
                      : { expected_version: version }),
                  });
                  await refresh();
                  setSelected(id);
                  setCreating(false);
                  setJustCreated(version === undefined);
                }, null, version === undefined ? "" : t("mcp.saved"))
              }
              addToProfiles={async (id, chosen) =>
                mutate(async () => {
                  let completed = 0;
                  try {
                    for (const profile of chosen) {
                      await api.putProfile(profile.id, {
                        name: profile.name ?? "",
                        description: profile.description ?? "",
                        mcp_servers: [...new Set([...profile.mcp_servers, id])],
                        hosted_tools: profile.hosted_tools,
                        expected_version: profile.version,
                      });
                      completed += 1;
                    }
                  } catch (caught) {
                    if (completed) {
                      await refresh();
                      throw new PartialProfileSaveError();
                    }
                    throw caught;
                  }
                  await refresh();
                  setJustCreated(false);
                }, null, t("mcp.addedToProfiles"))
              }
            />
          ) : null}
          {tab === "profile" && (currentProfile || creating) ? (
            <div ref={profileDetail}><McpProfileEditor
              profile={currentProfile}
              config={config}
              busy={busy}
              onOpenAgent={onOpenAgent}
              onEdit={() => setSuccess("")}
              remove={(profile) =>
                openDelete({
                  kind: "profile",
                  id: profile.id,
                  version: profile.version,
                })
              }
              rollback={(profile) => openHistory("profile", profile.id)}
              save={async (id, input) =>
                mutate(async () => {
                  await api.putProfile(id, input);
                  await refresh();
                  setSelected(id);
                  setCreating(false);
                }, null, t("mcp.saved"))
              }
            /></div>
          ) : null}
          {tab === "secret" && currentSecret ? (
            <McpSecretEditor
              secret={currentSecret}
              busy={busy}
              onEdit={() => setSuccess("")}
              remove={(secret: McpSecret) =>
                openDelete({ kind: "secret", id: secret.name })
              }
              replace={async (name, value) =>
                mutate(async () => {
                  await api.putSecret(name, value, config.current_revision);
                  await refresh();
                }, null, t("mcp.secretReplaced"))
              }
            />
          ) : null}
          {messagePlace === "footer" && !deleting && !history && error ? (
            <SettingsAlert scrollIntoView>{error}{" "}{error.includes("다시 읽은") ? <Button type="button" variant="outline" onClick={() => void refresh().then(() => setError("")).catch(() => undefined)}>{t("mcp.reload")}</Button> : null}</SettingsAlert>
          ) : null}
          {messagePlace === "footer" && success ? <SuccessMessage>{success}</SuccessMessage> : null}
        </SettingsListDetailFrame>
      </div>
      <McpDialogs
        deleting={deleting}
        history={history}
        nodes={currentProfile?.node_scope ?? []}
        busy={busy}
        error={error}
        profiles={deleting?.kind === "server" ? profiles.filter((p) => p.mcp_servers.includes(deleting.id)).map((p) => p.name || p.id) : []}
        reload={() => void refresh().then((next) => {
          if (deleting) {
            const item = deleting.kind === "server" ? next.servers.find((candidate) => candidate.id === deleting.id)
              : deleting.kind === "profile" ? next.profiles.find((candidate) => candidate.id === deleting.id)
              : next.secrets.find((candidate) => candidate.name === deleting.id);
            if (!item) { setDeleting(null); setMessagePlace("header"); setSuccess(t("mcp.alreadyDeleted", { id: deleting.id })); }
            else if ("version" in item) setDeleting({ ...deleting, version: item.version });
          }
          setError("");
        }).catch(() => undefined)}
        closeDelete={() => { setError(""); setDeleting(null); }}
        closeHistory={() => { setError(""); setHistory(null); }}
        remove={(target) => {
          void mutate(async () => {
            if (target.kind === "server")
              await api.deleteServer(target.id, target.version!);
            else if (target.kind === "profile")
              await api.deleteProfile(target.id, target.version!);
            else await api.deleteSecret(target.id, config.current_revision);
            await refresh();
            setSelected(null);
          }, target, t("mcp.deleted", { id: target.id }), "header", "delete").then((ok) => { if (ok) setDeleting(null); });
        }}
        rollback={(id) => {
          void mutate(async () => {
            await api.rollback(id, config.current_revision);
            await refresh();
          }, null, t("mcp.reverted"), "header", "rollback").then((ok) => { if (ok) setHistory(null); });
        }}
      />
    </div>
  );
}
