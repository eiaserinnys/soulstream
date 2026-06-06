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

import { useEffect, useMemo, useState } from "react";
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
