import "./config/config-layout.css";
import "../v3/v3-card-board.css";
import { DEFAULT_WALLPAPER_PHOTO_URL, WALLPAPER_PRESETS, fileToWallpaperDataUrl } from "@seosoyoung/soul-ui/lib/wallpaper-settings";
import { ArrowLeft, Check } from "lucide-react";
import { FileStorageTab } from "./FileStorageTab";
import { CardDispatchTab } from "./CardDispatchTab";
import { PersistentDefaultsSettingsForm } from "./PersistentDefaultsSettingsForm";
import { SummarySettingsForm } from "./SummarySettingsForm";
/**
 * ConfigModal - 설정 모달 (unified-dashboard)
 *
 * 모달 쉘 + 탭 선택 상태 + 하위 컴포넌트 조합만 담당한다.
 *   - 필드 렌더링  : components/config/SettingFieldWidget
 *   - 카테고리 탭  : components/config/ConfigCategoryNav
 *   - 결과 메시지  : components/config/ConfigResultMessage
 *   - API / 상태  : hooks/useConfigSettings
 *
 * V3 설정 탭과 운영 패널을 조합한다.
 */

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogPanel,
  Button,
  FrameLoading,
  DEFAULT_LIQUID_GLASS_SETTINGS,
  useAuth,
  useDashboardStore,
  type WallpaperMode,
} from "@seosoyoung/soul-ui";
import { NodePanel } from "./NodePanel";
import { V3_CARD_GAP_PX } from "../v3/v3-layout-metrics";
import { UserManagementTab } from "./UserManagementTab";
import { OwnedAgentsTab } from "./OwnedAgentsTab";
import { AccessLinksTab } from "./AccessLinksTab";
import { WebhooksTab } from "./WebhooksTab";
import { McpSettingsTab } from "./mcp/McpSettingsTab";
import { AgentProfileEditorTab } from "./AgentProfileEditorTab";
import { SkillCatalogTab } from "./guides/SkillCatalogTab";
import { resetGuideSession } from "../lib/skill-guides";
import { SettingFieldWidget } from "./config/SettingFieldWidget";
import { ConfigCategoryNav } from "./config/ConfigCategoryNav";
import { DEFAULT_CONFIG_TAB_ID, visibleConfigTabs } from "./config/configTabs";
import { ConfigResultMessage } from "./config/ConfigResultMessage";
import { useConfigSettings } from "../hooks/useConfigSettings";
import {
  readPersistentSessionDevicePreferences,
  setPersistentSessionOpenOnStart,
} from "../lib/persistent-session-device-preferences";
import { LiquidGlassTab } from "./LiquidGlassTab";
import { ChatTypographyTab } from "./ChatTypographyTab";
import { LanguageSettings } from "./LanguageSettings";
import { SessionReviewPolicyTab } from "./SessionReviewPolicyTab";
import { UsageLogTab } from "./UsageLogTab";
import { RecurringJobsTab } from "./RecurringJobsTab";
import { PersistentSessionsTab } from "./PersistentSessionsTab";
import { CodingAgentsTab } from "./CodingAgentsTab";
import { GitReposTab } from "./GitReposTab";
import { UsageStatsTab } from "./usage-stats/UsageStatsTab";

export interface ConfigModalApi {
  request: typeof fetch;
  recurring: typeof import("./RecurringJobsTab").recurringJobsApi;
  cards: typeof import("@seosoyoung/soul-ui/cards/card-api").cardRequest;
  orchestration: import("./CardOrchestrationSettingsForm").CardOrchestrationSettingsService;
  nodes: ReturnType<typeof import("../store/orchestrator-store").useOrchestratorStore.getState>["nodes"];
  assignment: import("../v3/AgentNodeAssignmentFields").AssignmentData;
}
interface ConfigModalProps {
  initialTab?: string;
  /** persistent 탭을 열 때 처음 골라 둘 영구 세션. */
  initialPersistentSessionId?: string | null;
  /** 설정창에서 영구 세션을 저장한 뒤 저장값을 받는다(PAS 창이 새로 읽지 않고 반영한다). */
  onPersistentSessionSaved?(session: import("../lib/persistent-sessions").PersistentSession): void;
  userEditor?: "create" | "edit";
  api?: ConfigModalApi;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConfigModal({ open, onOpenChange, api, initialTab, userEditor, initialPersistentSessionId, onPersistentSessionSaved }: ConfigModalProps) {
  const { t } = useTranslation();
  const { user } = useAuth();

  const {
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
  } = useConfigSettings(open, api?.request);

  const [localChat, setLocalChat] = useState<import("@seosoyoung/soul-ui").ChatFontSize>(14);
  const [localGlass, setLocalGlass] = useState(DEFAULT_LIQUID_GLASS_SETTINGS);
  const [selectedTab, setSelectedTab] = useState<string>(initialTab ?? DEFAULT_CONFIG_TAB_ID);
  const [mcpProfileTarget, setMcpProfileTarget] = useState<string | undefined>();
  const [agentMcpTarget, setAgentMcpTarget] = useState<{ agentId: string; nodeId: string } | undefined>();
  const userEmail = typeof user?.email === "string" ? user.email : null;
  const [pasDevicePreferences, setPasDevicePreferences] = useState(() => userEmail
    ? readPersistentSessionDevicePreferences(userEmail)
    : { openOnStart: false, lastSessionId: null });
  const [mobileIndex, setMobileIndex] = useState(() => !initialTab && narrowSettingsViewport());
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const saveInFlight = useRef(false);
  const saveChanges = async () => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    try { await save(); } finally { saveInFlight.current = false; }
  };
  const isAdmin = Boolean(api || user?.isAdmin);
  const tabs = useMemo(() => visibleConfigTabs(isAdmin, t), [isAdmin, t]);

  // 카테고리 로드 시 첫 탭 선택. 모달을 닫으면 다음 오픈 시 재선택되도록 리셋.
  useEffect(() => {
    if (!selectedTab) {
      const firstTab = initialTab ?? DEFAULT_CONFIG_TAB_ID;
      if (firstTab) setSelectedTab(firstTab);
    }
  }, [categories, tabs, selectedTab]);
  useEffect(() => {
    if (!open) { setSelectedTab(initialTab ?? DEFAULT_CONFIG_TAB_ID); setMobileIndex(!initialTab && narrowSettingsViewport()); setDiscardPrompt(false); resetGuideSession(); }
  }, [open]);
  useEffect(() => {
    if (open && userEmail) setPasDevicePreferences(readPersistentSessionDevicePreferences(userEmail));
  }, [open, userEmail]);

  const activeCategory = categories.find((c) => c.name === selectedTab);
  const selectedDefinition = tabs.find(tab => tab.id === selectedTab);
  const isUsageStatsTab = selectedTab === "usage_stats";
  const hasTabs = categories.length > 0 || tabs.length > 0;

  const activeLabel = selectedDefinition?.label ?? activeCategory?.label ?? t("settings.title");
  const close = () => { if (saving || saveInFlight.current) return; if (hasChanges) setDiscardPrompt(true); else onOpenChange(false); };
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
      <DialogPopup className="approved-dialog config-dialog max-w-5xl" closeProps={{ disabled: saving, onClick: event => { event.preventDefault(); close(); } }} style={{ "--v3-card-gap": `${V3_CARD_GAP_PX}px` } as CSSProperties}>
        <DialogHeader>
          <DialogTitle>{t("settings.title")}</DialogTitle>
        </DialogHeader>

        <DialogPanel className="config-dialog-panel" scrollable={false} scrollFade={false}>
          {loading && <FrameLoading label={t("settings.loading")} />}
          {error && !loading && (
            <div className="text-destructive-foreground text-sm py-4 text-center" data-v3-selectable-content="true">
              ❌ {error}
            </div>
          )}
          {!loading && hasTabs && (
            <div className="config-layout" data-mobile-index={mobileIndex}>
              <ConfigCategoryNav
                categories={categories}
                tabs={tabs}
                activeCategory={selectedTab}
                onSelect={name => { setSelectedTab(name); setMobileIndex(false); setMcpProfileTarget(undefined); setAgentMcpTarget(undefined); }}
              />
              <section className="config-detail" aria-label={activeLabel}>
              <button type="button" className="config-back" onClick={() => setMobileIndex(true)}><ArrowLeft className="size-4" aria-hidden="true"/>{t("settings.allSettings")}</button>
              <header className="config-detail-heading"><h2>{activeLabel}</h2><p>{selectedDefinition?.description ?? t("settings.defaultCategoryDescription")}</p></header>
              {selectedDefinition?.id === "appearance" ? <div className="config-appearance">
                <WallpaperPicker local={Boolean(api)} />
                <LanguageSettings />
                <ChatTypographyTab preference={api ? {value:localChat,set:setLocalChat} : undefined}/>
                {userEmail ? <SettingFieldWidget
                  className="config-pas-open-on-start"
                  field={{ key: "pas_open_on_start", field_name: "pas_open_on_start", label: t("settings.openPersistent"), description: "", value: pasDevicePreferences.openOnStart, value_type: "bool", sensitive: false, hot_reloadable: true, read_only: false }}
                  value={String(pasDevicePreferences.openOnStart)}
                  onChange={(value) => {
                    const next = setPersistentSessionOpenOnStart(userEmail, value === "true");
                    setPasDevicePreferences(next);
                  }}
                /> : null}
                <details className="config-advanced"><summary>{t("settings.glassDetails")}<span>{t("settings.advanced")}</span></summary><LiquidGlassTab preference={api ? {value:localGlass,set:patch=>setLocalGlass(value=>({...value,...patch}))} : undefined}/></details>
              </div> : selectedDefinition?.id === "nodes" ? (
                // 구역 틀 테두리는 두지 않는다. 노드 카드와 사용량 행이 이미 테두리를 가진다.
                <div>
                  <NodePanel request={api?.request} sampleNodes={api?.nodes} />
                </div>
              ) : selectedDefinition?.id === "recurring_jobs" ? (
                <RecurringJobsTab api={api?.recurring} assignment={api?.assignment} />
              ) : selectedDefinition?.id === "persistent" ? (
                <PersistentSessionsTab request={api?.request} assignment={api?.assignment} initialPersistentSessionId={initialPersistentSessionId} onSessionSaved={onPersistentSessionSaved} />
              ) : selectedDefinition?.id === "usage_log" ? (
                <UsageLogTab request={api?.request} />
              ) : selectedDefinition?.id === "usage_stats" ? (
                <UsageStatsTab request={api?.request} />
              ) : selectedDefinition?.id === "session_review" ? (
                <SessionReviewPolicyTab request={api?.request} />
              ) : selectedDefinition?.id === "file_storage" ? (
                <FileStorageTab request={api?.request} />
              ) : selectedDefinition?.id === "card_dispatch" ? (
                <CardDispatchTab api={api?.cards} orchestration={api?.orchestration} />
              ) : selectedDefinition?.id === "coding_agents" ? (
                <CodingAgentsTab request={api?.request} sampleNodes={api?.nodes} />
              ) : selectedDefinition?.id === "git_repos" ? (
                <GitReposTab request={api?.request} sampleNodes={api?.nodes} />
              ) : selectedDefinition?.id === "persistent_defaults" ? (
                <PersistentDefaultsSettingsForm />
              ) : selectedDefinition?.id === "summaries" ? (
                <SummarySettingsForm />
              ) : selectedDefinition?.id === "mcp" ? (
                open && !mobileIndex ? <McpSettingsTab request={api?.request} initialProfileId={mcpProfileTarget} onOpenAgent={(agentId, nodeId) => { setAgentMcpTarget({ agentId, nodeId }); setSelectedTab("agents"); setMobileIndex(false); }} /> : null
              ) : selectedDefinition?.id === "agents" ? (
                <AgentProfileEditorTab request={api?.request} initialMcpTarget={agentMcpTarget} onEditMcpProfile={profileId => { setMcpProfileTarget(profileId); setSelectedTab("mcp"); setMobileIndex(false); }} />
              ) : selectedDefinition?.id === "skills" ? (
                open && !mobileIndex ? <SkillCatalogTab request={api?.request} /> : null
              ) : selectedDefinition?.id === "owned_agents" ? (
                open && !mobileIndex ? <OwnedAgentsTab request={api?.request} /> : null
              ) : selectedDefinition?.id === "access_links" ? (
                open && !mobileIndex ? <AccessLinksTab request={api?.request} /> : null
              ) : selectedDefinition?.id === "webhooks" ? (
                open && !mobileIndex ? <WebhooksTab request={api?.request} /> : null
              ) : selectedDefinition?.id === "users" ? (
                <UserManagementTab request={api?.request} initialEditor={userEditor} />
              ) : activeCategory ? (
                <div className="space-y-2">
                  {activeCategory.fields.map((field) => (
                    <SettingFieldWidget
                      key={field.key}
                      field={field}
                      value={formData[field.key] ?? ""}
                      onChange={(v) => updateField(field.key, v)}
                    />
                  ))}
                </div>
              ) : null}
              </section>
            </div>
          )}
        </DialogPanel>

        <DialogFooter className="config-footer">
          <ConfigResultMessage result={result}/>
          {discardPrompt ? <div className="config-discard" role="alert">
            <div><strong>{t("settings.unsavedTitle")}</strong><p>{t("settings.unsavedDetail")}</p></div>
            <Button variant="outline" onClick={() => setDiscardPrompt(false)}>{t("settings.continueEditing")}</Button>
            <Button variant="destructive" onClick={() => onOpenChange(false)}>{t("settings.discard")}</Button>
          </div> : <div className="config-footer-row">
            <p className="config-save-state">{isUsageStatsTab ? null : hasChanges ? t("settings.changedCount", { count: changedKeys.length }) : selectedDefinition?.id === "appearance" ? <><Check className="size-4" aria-hidden="true"/> {t("settings.applied")}</> : selectedDefinition ? t("settings.applyIndividually") : t("settings.restartNotice")}</p>
            <Button variant="outline" disabled={saving} onClick={close}>{!isUsageStatsTab && hasChanges ? t("settings.cancel") : t("settings.done")}</Button>
            {!isUsageStatsTab && (hasChanges || !selectedDefinition) ? <Button data-testid="config-save-button" disabled={!hasChanges || saving} onClick={() => void saveChanges()}>
              {saving ? t("settings.saving") : t("settings.save")}
            </Button> : null}
          </div>}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function narrowSettingsViewport(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 40rem)").matches;
}

const WALLPAPER_STYLES: Array<{ mode: Exclude<WallpaperMode, "photo">; label: string }> = [
  { mode: "bokeh", label: "settings.bokeh" },
  { mode: "metal", label: "settings.metal" },
  { mode: "plain", label: "settings.plain" },
];

interface WallpaperTile {
  key: string;
  label: string;
  thumbUrl?: string;
  selected: boolean;
  apply: () => void;
}

function WallpaperPicker({ local = false }: {local?: boolean}) {
  const { t } = useTranslation();
  const storedWallpaper = useDashboardStore((s) => s.wallpaper);
  const storedUploadedUrl = useDashboardStore((s) => s.uploadedBackgroundUrl);
  const storedSetWallpaper = useDashboardStore((s) => s.setWallpaper);
  const storedSetWallpaperMode = useDashboardStore((s) => s.setWallpaperMode);
  const storedSetWallpaperCustomImage = useDashboardStore((s) => s.setWallpaperCustomImage);
  const [localWallpaper, setLocalWallpaper] = useState(storedWallpaper);
  const [localUploadedUrl, setLocalUploadedUrl] = useState<string | null>(null);
  const wallpaper = local ? localWallpaper : storedWallpaper;
  const uploadedUrl = local ? localUploadedUrl : storedUploadedUrl;
  const setWallpaper = local ? setLocalWallpaper : storedSetWallpaper;
  const setWallpaperMode = local ? (mode: WallpaperMode) => setLocalWallpaper(value=>({...value,mode})) : storedSetWallpaperMode;
  const setWallpaperCustomImage = local ? async (file: File) => { const data = await fileToWallpaperDataUrl(file); setLocalUploadedUrl(data); setLocalWallpaper(value=>({...value,customImage:data,mode:"photo"})); } : storedSetWallpaperCustomImage;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadInFlight = useRef(false);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || uploadInFlight.current) return;
    if (!file.type.startsWith("image/")) { setError(t("settings.invalidImage")); return; }
    uploadInFlight.current = true;
    setError(null);
    setUploading(true);
    try {
      await setWallpaperCustomImage(file);
    } catch (err) {
      setError(t("settings.imageError"));
    } finally {
      uploadInFlight.current = false;
      setUploading(false);
    }
  };

  const tiles: WallpaperTile[] = [
    ...WALLPAPER_STYLES.map((style) => ({
      key: style.mode,
      label: t(style.label),
      selected: wallpaper.mode === style.mode,
      apply: () => setWallpaperMode(style.mode),
    })),
    ...WALLPAPER_PRESETS.map((preset) => ({
      key: preset.id,
      label: t(`settings.wallpaper.${preset.id}`),
      thumbUrl: preset.thumbUrl,
      selected: wallpaper.mode === "photo" && (wallpaper.customImage ?? DEFAULT_WALLPAPER_PHOTO_URL) === preset.url,
      apply: () => setWallpaper({ mode: "photo", customImage: preset.url }),
    })),
    ...(uploadedUrl ? [{
      key: "uploaded",
      label: t("settings.myPhoto"),
      thumbUrl: uploadedUrl,
      selected: wallpaper.mode === "photo" && wallpaper.customImage === uploadedUrl,
      apply: () => setWallpaper({ mode: "photo", customImage: uploadedUrl }),
    }] : []),
  ];

  return (
    <section className="config-wallpaper">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="mt-0.5 text-sm font-semibold text-foreground">
            {t("settings.background")}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full"
          disabled={uploading}
          onClick={() => { if (!uploadInFlight.current) fileInputRef.current?.click(); }}
        >
          {uploading ? t("settings.uploading") : t("settings.upload")}
        </Button>
      </div>
      <div className="config-wallpaper-options">
        {tiles.map((tile) => (
          <button
            key={tile.key}
            type="button"
            disabled={uploading}
            data-wallpaper={tile.key}
            aria-pressed={tile.selected}
            onClick={tile.apply}
          >
            <span className="wallpaper-swatch" aria-hidden="true">
              {tile.thumbUrl && <img src={tile.thumbUrl} alt="" loading="lazy" draggable={false}/>}
            </span>
            <span>{tile.label}</span>
          </button>
        ))}
      </div>
      {error && (
        <div role="alert" className="mt-2 rounded-floor bg-accent-red/10 px-3 py-2 text-sm text-destructive-foreground" data-v3-selectable-content="true">
          {error}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => void handleFileChange(event)}
      />
    </section>
  );
}
