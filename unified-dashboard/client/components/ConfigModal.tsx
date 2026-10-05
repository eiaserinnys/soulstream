import "./config/config-layout.css";
import { fileToWallpaperDataUrl } from "@seosoyoung/soul-ui/lib/wallpaper-settings";
import { ArrowLeft, Check } from "lucide-react";
import { FileStorageTab } from "./FileStorageTab";
import { CardDispatchTab } from "./CardDispatchTab";
/**
 * ConfigModal - 서버 설정 편집 모달 (unified-dashboard)
 *
 * 모달 쉘 + 탭 선택 상태 + 하위 컴포넌트 조합만 담당한다.
 *   - 필드 렌더링  : components/config/SettingFieldWidget
 *   - 카테고리 탭  : components/config/ConfigCategoryNav
 *   - 결과 메시지  : components/config/ConfigResultMessage
 *   - API / 상태  : hooks/useConfigSettings
 *
 * V3 설정 탭과 운영 패널을 조합한다.
 */

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  Button,
  DEFAULT_LIQUID_GLASS_SETTINGS,
  useAuth,
  useDashboardStore,
  type WallpaperMode,
} from "@seosoyoung/soul-ui";
import { NodePanel } from "./NodePanel";
import { UserManagementTab } from "./UserManagementTab";
import { OwnedAgentsTab } from "./OwnedAgentsTab";
import { AgentProfileEditorTab } from "./AgentProfileEditorTab";
import { SettingFieldWidget } from "./config/SettingFieldWidget";
import { ConfigCategoryNav } from "./config/ConfigCategoryNav";
import { ConfigResultMessage } from "./config/ConfigResultMessage";
import { useConfigSettings } from "../hooks/useConfigSettings";
import { LiquidGlassTab } from "./LiquidGlassTab";
import { ChatTypographyTab } from "./ChatTypographyTab";
import { SessionReviewPolicyTab } from "./SessionReviewPolicyTab";
import { UsageLogTab } from "./UsageLogTab";
import { RecurringJobsTab } from "./RecurringJobsTab";
import { PersistentSessionsTab } from "./PersistentSessionsTab";

const LIQUID_GLASS_TAB_NAME = "liquid_glass";
const CHAT_TAB_NAME = "chat";
const NODES_TAB_NAME = "nodes";
const USERS_TAB_NAME = "users";
const AGENTS_TAB_NAME = "agents";
const OWNED_AGENTS_TAB_NAME = "owned_agents";
const SESSION_REVIEW_TAB_NAME = "session_review";
const USAGE_LOG_TAB_NAME = "usage_log";
const RECURRING_JOBS_TAB_NAME = "recurring_jobs";
const PERSISTENT_TAB_NAME = "persistent";

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
  userEditor?: "create" | "edit";
  api?: ConfigModalApi;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConfigModal({ open, onOpenChange, api, initialTab, userEditor }: ConfigModalProps) {
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
  const [selectedTab, setSelectedTab] = useState<string>(initialTab ?? "appearance");
  const [mobileIndex, setMobileIndex] = useState(!initialTab);
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const saveInFlight = useRef(false);
  const saveChanges = async () => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    try { await save(); } finally { saveInFlight.current = false; }
  };
  const extraTabs = useMemo(() => {
    return [
      { name: "appearance", label: "화면과 읽기" },
      { name: OWNED_AGENTS_TAB_NAME, label: "내 에이전트" },
      { name: NODES_TAB_NAME, label: "노드" },
      { name: RECURRING_JOBS_TAB_NAME, label: "반복 작업" },
      { name: PERSISTENT_TAB_NAME, label: "영구 에이전트 세션" },
      { name: USAGE_LOG_TAB_NAME, label: "사용 로그" },
      ...((api || user?.isAdmin) ? [
        { name: SESSION_REVIEW_TAB_NAME, label: "요청 검수" },
        { name: "file_storage", label: "파일 저장소" },
        { name: "card_dispatch", label: "카드 실행" },
        { name: AGENTS_TAB_NAME, label: "에이전트" },
        { name: USERS_TAB_NAME, label: "사용자" },
      ] : []),
    ];
  }, [(api || user?.isAdmin)]);

  // 카테고리 로드 시 첫 탭 선택. 모달을 닫으면 다음 오픈 시 재선택되도록 리셋.
  useEffect(() => {
    if (!selectedTab) {
      const firstTab = initialTab ?? "appearance";
      if (firstTab) setSelectedTab(firstTab);
    }
  }, [categories, extraTabs, selectedTab]);
  useEffect(() => {
    if (!open) { setSelectedTab(initialTab ?? "appearance"); setMobileIndex(!initialTab); setDiscardPrompt(false); }
  }, [open]);

  const activeCategory = categories.find((c) => c.name === selectedTab);
  const isNonConfigTab = selectedTab === "appearance" ||
    selectedTab === LIQUID_GLASS_TAB_NAME ||
    selectedTab === CHAT_TAB_NAME ||
    selectedTab === NODES_TAB_NAME ||
    selectedTab === RECURRING_JOBS_TAB_NAME ||
    selectedTab === PERSISTENT_TAB_NAME ||
    selectedTab === "file_storage" ||
    selectedTab === "card_dispatch" ||
    selectedTab === SESSION_REVIEW_TAB_NAME ||
    selectedTab === USAGE_LOG_TAB_NAME ||
    selectedTab === AGENTS_TAB_NAME ||
    selectedTab === OWNED_AGENTS_TAB_NAME ||
    selectedTab === USERS_TAB_NAME;
  const hasTabs = categories.length > 0 || extraTabs.length > 0;

  const activeLabel = selectedTab === "appearance" ? "화면과 읽기" : [...categories, ...extraTabs].find(tab => tab.name === selectedTab)?.label ?? "설정";
  const descriptions: Record<string, string> = {
    appearance: "나에게 편안한 배경과 대화 글자 크기를 고릅니다.",
    owned_agents: "내 에이전트의 이름과 활성 상태, 연결 키를 관리합니다.",
    nodes: "작업을 실행할 기기와 연결 상태를 확인합니다.", agents: "에이전트의 프로필과 기본 실행 환경을 관리합니다.",
    recurring_jobs: "반복할 작업과 다음 실행 시점을 관리합니다.", persistent: "Persistent Agent Session의 이름과 기본 모델을 관리합니다.", card_dispatch: "카드의 실행 방식과 동시 실행 수를 조정합니다.",
    users: "서버를 사용할 사람과 접근 범위를 관리합니다.", session_review: "실행 전 검수가 필요한 요청을 정합니다.",
    file_storage: "첨부 파일을 보관할 저장소를 연결합니다.", usage_log: "사용 기록을 확인하고 필요한 범위로 좁힙니다.",
  };
  const close = () => { if (saving || saveInFlight.current) return; if (hasChanges) setDiscardPrompt(true); else onOpenChange(false); };
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) close(); }}>
      <DialogPopup className="approved-dialog config-dialog max-w-5xl" closeProps={{ disabled: saving, onClick: event => { event.preventDefault(); close(); } }}>
        <DialogHeader>
          <DialogTitle>설정</DialogTitle>
          <DialogDescription>
            개인 환경부터 서버 운영까지, 필요한 설정을 찾으세요.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="config-dialog-panel">
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
          {!loading && hasTabs && (
            <div className="config-layout" data-mobile-index={mobileIndex}>
              <ConfigCategoryNav
                categories={categories}
                extraTabs={extraTabs}
                activeCategory={selectedTab}
                onSelect={name => { setSelectedTab(name); setMobileIndex(false); }}
              />
              <section className="config-detail" aria-label={activeLabel}>
              <button type="button" className="config-back" onClick={() => setMobileIndex(true)}><ArrowLeft className="size-4" aria-hidden="true"/>모든 설정</button>
              <header className="config-detail-heading"><h2>{activeLabel}</h2><p>{descriptions[selectedTab] ?? "서버에 적용할 값을 변경한 뒤 저장하세요."}</p></header>
              {selectedTab === "appearance" ? <div className="config-appearance">
                <WallpaperPicker local={Boolean(api)} />
                <ChatTypographyTab preference={api ? {value:localChat,set:setLocalChat} : undefined}/>
                <details className="config-advanced"><summary>유리 효과 세부 조정<span>고급</span></summary><LiquidGlassTab preference={api ? {value:localGlass,set:patch=>setLocalGlass(value=>({...value,...patch}))} : undefined}/></details>
              </div> : selectedTab === CHAT_TAB_NAME ? (
                <ChatTypographyTab preference={api ? {value:localChat,set:setLocalChat} : undefined} />
              ) : selectedTab === LIQUID_GLASS_TAB_NAME ? (
                <LiquidGlassTab preference={api ? {value:localGlass,set:patch=>setLocalGlass(value=>({...value,...patch}))} : undefined} />
              ) : selectedTab === NODES_TAB_NAME ? (
                <div className="h-[420px] overflow-hidden rounded border border-border">
                  <NodePanel request={api?.request} sampleNodes={api?.nodes} />
                </div>
              ) : selectedTab === RECURRING_JOBS_TAB_NAME ? (
                <RecurringJobsTab api={api?.recurring} assignment={api?.assignment} />
              ) : selectedTab === PERSISTENT_TAB_NAME ? (
                <PersistentSessionsTab request={api?.request} assignment={api?.assignment} />
              ) : selectedTab === USAGE_LOG_TAB_NAME ? (
                <UsageLogTab request={api?.request} />
              ) : selectedTab === SESSION_REVIEW_TAB_NAME ? (
                <SessionReviewPolicyTab request={api?.request} />
              ) : selectedTab === "file_storage" && (api || user?.isAdmin) ? (
                <FileStorageTab request={api?.request} />
              ) : selectedTab === "card_dispatch" ? (
                <CardDispatchTab api={api?.cards} orchestration={api?.orchestration} />
              ) : selectedTab === AGENTS_TAB_NAME ? (
                <AgentProfileEditorTab request={api?.request} />
              ) : selectedTab === OWNED_AGENTS_TAB_NAME ? (
                open && !mobileIndex ? <OwnedAgentsTab request={api?.request} /> : null
              ) : selectedTab === USERS_TAB_NAME ? (
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
            <div><strong>저장하지 않은 변경이 있습니다</strong><p>창을 닫으면 서버 설정 변경이 사라집니다.</p></div>
            <Button variant="outline" onClick={() => setDiscardPrompt(false)}>계속 편집</Button>
            <Button variant="destructive" onClick={() => onOpenChange(false)}>변경 버리기</Button>
          </div> : <div className="config-footer-row">
            <p className="config-save-state">{hasChanges ? `${changedKeys.length}개 변경, 아직 저장되지 않음` : selectedTab === "appearance" ? <><Check className="size-4" aria-hidden="true"/> 변경 즉시 적용</> : isNonConfigTab ? "각 항목의 버튼으로 변경을 적용합니다" : "재시작이 필요한 항목은 별도로 표시됩니다"}</p>
            <Button variant="outline" disabled={saving} onClick={close}>{hasChanges ? "취소" : "완료"}</Button>
            {hasChanges || !isNonConfigTab ? <Button data-testid="config-save-button" disabled={!hasChanges || saving} onClick={() => void saveChanges()}>
              {saving ? "저장 중…" : "변경 저장"}
            </Button> : null}
          </div>}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const WALLPAPER_OPTIONS: Array<{ mode: WallpaperMode; label: string }> = [
  { mode: "bokeh", label: "보케" },
  { mode: "metal", label: "메탈" },
  { mode: "photo", label: "사진" },
  { mode: "plain", label: "단색" },
];

function WallpaperPicker({ local = false }: {local?: boolean}) {
  const storedWallpaper = useDashboardStore((s) => s.wallpaper);
  const storedSetWallpaper = useDashboardStore((s) => s.setWallpaper);
  const storedSetWallpaperMode = useDashboardStore((s) => s.setWallpaperMode);
  const storedSetWallpaperCustomImage = useDashboardStore((s) => s.setWallpaperCustomImage);
  const [localWallpaper, setLocalWallpaper] = useState(storedWallpaper);
  const wallpaper = local ? localWallpaper : storedWallpaper;
  const setWallpaper = local ? setLocalWallpaper : storedSetWallpaper;
  const setWallpaperMode = local ? (mode: WallpaperMode) => setLocalWallpaper(value=>({...value,mode})) : storedSetWallpaperMode;
  const setWallpaperCustomImage = local ? async (file: File) => { const data = await fileToWallpaperDataUrl(file); setLocalWallpaper(value=>({...value,customImage:data,mode:"photo"})); } : storedSetWallpaperCustomImage;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadInFlight = useRef(false);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || uploadInFlight.current) return;
    if (!file.type.startsWith("image/")) { setError("이미지 파일을 선택하세요."); return; }
    uploadInFlight.current = true;
    setError(null);
    setUploading(true);
    try {
      await setWallpaperCustomImage(file);
    } catch (err) {
      setError("배경 이미지를 읽지 못했습니다. 다른 이미지 파일을 선택하세요.");
    } finally {
      uploadInFlight.current = false;
      setUploading(false);
    }
  };

  return (
    <section className="config-wallpaper">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="mt-0.5 text-sm font-semibold text-foreground">
            배경
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
          {uploading ? "처리 중..." : "사진 업로드"}
        </Button>
      </div>
      <div className="config-wallpaper-options">
        {WALLPAPER_OPTIONS.map((option) => (
          <button
            key={option.mode}
            type="button"
            className={
              wallpaper.mode === option.mode
                ? "rounded-full border border-accent-blue/55 bg-accent-blue/15 px-3 py-1.5 text-xs font-semibold text-foreground"
                : "rounded-full border border-[var(--lg-line)] bg-muted/40 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:border-accent-blue/40 hover:text-foreground"
            }
            disabled={uploading}
            data-wallpaper={option.mode}
            aria-pressed={wallpaper.mode === option.mode}
            onClick={() => setWallpaperMode(option.mode)}
          >
            <span className="wallpaper-swatch" aria-hidden="true"/><span>{option.label}</span>
          </button>
        ))}
      </div>
      {error && (
        <div role="alert" className="mt-2 rounded-lg bg-accent-red/10 px-3 py-2 text-sm text-accent-red">
          {error}
        </div>
      )}
      {wallpaper.customImage && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 rounded-full px-0 text-sm text-muted-foreground hover:text-foreground"
          disabled={uploading}
          onClick={() => setWallpaper({ mode: "bokeh" })}
        >
          기본값 복원
        </Button>
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
