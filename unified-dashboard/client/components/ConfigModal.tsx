/**
 * ConfigModal - 서버 설정 편집 모달 (unified-dashboard)
 *
 * 모달 쉘 + 탭 선택 상태 + 하위 컴포넌트 조합만 담당한다.
 *   - 필드 렌더링  : components/config/SettingFieldWidget
 *   - 카테고리 탭  : components/config/ConfigCategoryNav
 *   - 결과 메시지  : components/config/ConfigResultMessage
 *   - API / 상태  : hooks/useConfigSettings
 *
 * orchestrator 모드에서는 NodePanel이 Claude Auth를 처리하므로 해당 탭을 숨긴다.
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
  useAuth,
  useDashboardStore,
  type WallpaperMode,
} from "@seosoyoung/soul-ui";
import { useAppConfig } from "../config/AppConfigContext";
import { ClaudeAuthTab } from "./ClaudeAuthTab";
import { NodePanel } from "./NodePanel";
import { UserManagementTab } from "./UserManagementTab";
import { SettingFieldWidget } from "./config/SettingFieldWidget";
import { ConfigCategoryNav } from "./config/ConfigCategoryNav";
import { ConfigResultMessage } from "./config/ConfigResultMessage";
import { useConfigSettings } from "../hooks/useConfigSettings";

const CLAUDE_AUTH_TAB_NAME = "claude_auth";
const CLAUDE_AUTH_TAB_LABEL = "Claude Code 인증";
const NODES_TAB_NAME = "nodes";
const USERS_TAB_NAME = "users";

interface ConfigModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConfigModal({ open, onOpenChange }: ConfigModalProps) {
  const config = useAppConfig();
  const { user } = useAuth();
  const showClaudeAuthTab = config.mode !== "orchestrator";

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
  } = useConfigSettings(open);

  const [selectedTab, setSelectedTab] = useState<string>("");
  const extraTabs = useMemo(() => {
    if (config.mode === "orchestrator") {
      return [
        { name: NODES_TAB_NAME, label: "노드" },
        ...(user?.isAdmin ? [{ name: USERS_TAB_NAME, label: "사용자" }] : []),
      ];
    }
    return showClaudeAuthTab
      ? [{ name: CLAUDE_AUTH_TAB_NAME, label: CLAUDE_AUTH_TAB_LABEL }]
      : [];
  }, [config.mode, showClaudeAuthTab, user?.isAdmin]);

  // 카테고리 로드 시 첫 탭 선택. 모달을 닫으면 다음 오픈 시 재선택되도록 리셋.
  useEffect(() => {
    if (!selectedTab) {
      const firstTab = categories[0]?.name ?? extraTabs[0]?.name;
      if (firstTab) setSelectedTab(firstTab);
    }
  }, [categories, extraTabs, selectedTab]);
  useEffect(() => {
    if (!open) setSelectedTab("");
  }, [open]);

  const activeCategory = categories.find((c) => c.name === selectedTab);
  const isOperationalTab = selectedTab === NODES_TAB_NAME || selectedTab === USERS_TAB_NAME;
  const hasTabs = categories.length > 0 || extraTabs.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>⚙️ 서버 설정</DialogTitle>
          <DialogDescription>
            서버 설정과 운영 패널을 관리합니다. 🔄 표시된 항목은 서버 재시작 후 적용됩니다.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <WallpaperPicker />
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
          {!loading && !error && hasTabs && (
            <>
              <ConfigCategoryNav
                categories={categories}
                extraTabs={extraTabs}
                activeCategory={selectedTab}
                onSelect={setSelectedTab}
              />
              {selectedTab === CLAUDE_AUTH_TAB_NAME ? (
                <ClaudeAuthTab />
              ) : selectedTab === NODES_TAB_NAME ? (
                <div className="h-[420px] overflow-hidden rounded border border-border">
                  <NodePanel />
                </div>
              ) : selectedTab === USERS_TAB_NAME ? (
                <UserManagementTab />
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
            </>
          )}
        </DialogPanel>

        <DialogFooter>
          <div className="flex flex-col w-full gap-2">
            <ConfigResultMessage result={result} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                닫기
              </Button>
              <Button
                data-testid="config-save-button"
                size="sm"
                disabled={isOperationalTab || !hasChanges || saving}
                onClick={save}
              >
                {saving ? "저장 중..." : `저장${hasChanges ? ` (${changedKeys.length})` : ""}`}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const WALLPAPER_OPTIONS: Array<{ mode: WallpaperMode; label: string }> = [
  { mode: "bokeh", label: "Bokeh" },
  { mode: "metal", label: "Metal" },
  { mode: "photo", label: "Photo" },
  { mode: "plain", label: "Plain" },
];

function WallpaperPicker() {
  const wallpaper = useDashboardStore((s) => s.wallpaper);
  const setWallpaperMode = useDashboardStore((s) => s.setWallpaperMode);
  const setWallpaperCustomImage = useDashboardStore((s) => s.setWallpaperCustomImage);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      await setWallpaperCustomImage(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "배경 이미지를 읽지 못했습니다");
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className="mb-4 rounded-[18px] border border-glass-border bg-[var(--lg-card)] px-4 py-3 shadow-[0_8px_26px_-18px_rgb(20_26_40_/_45%)]">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground/70">
            Wallpaper
          </div>
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
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? "처리 중..." : "커스텀 업로드"}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {WALLPAPER_OPTIONS.map((option) => (
          <button
            key={option.mode}
            type="button"
            className={
              wallpaper.mode === option.mode
                ? "rounded-full border border-accent-blue/55 bg-accent-blue/15 px-3 py-1.5 text-xs font-semibold text-foreground"
                : "rounded-full border border-[var(--lg-line)] bg-muted/40 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:border-accent-blue/40 hover:text-foreground"
            }
            aria-pressed={wallpaper.mode === option.mode}
            onClick={() => setWallpaperMode(option.mode)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {error && (
        <div className="mt-2 rounded-[13px] bg-accent-red/10 px-3 py-2 text-xs text-accent-red">
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
