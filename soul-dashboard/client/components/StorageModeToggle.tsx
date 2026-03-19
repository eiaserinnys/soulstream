/**
 * StorageModeToggle - 스토리지 모드 전환 UI
 *
 * SSE 모드(Soul Server API + SSE 실시간)와 Serendipity 모드 사이를 전환합니다.
 */

import { useDashboardStore, cn, type StorageMode } from "@seosoyoung/soul-ui";

interface StorageModeOption {
  value: StorageMode;
  label: string;
  description: string;
  icon: string;
}

const STORAGE_MODES: StorageModeOption[] = [
  {
    value: "sse",
    label: "SSE",
    description: "Soul Server API + SSE 실시간",
    icon: "📡",
  },
  {
    value: "serendipity",
    label: "Serendipity",
    description: "세렌디피티 API",
    icon: "✨",
  },
];

export function StorageModeToggle() {
  const storageMode = useDashboardStore((s) => s.storageMode);
  const setStorageMode = useDashboardStore((s) => s.setStorageMode);

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-slate-800/50 rounded-lg">
      <span className="text-xs text-slate-400 mr-1">Mode:</span>
      <div className="flex gap-1">
        {STORAGE_MODES.map((mode) => (
          <button
            key={mode.value}
            onClick={() => setStorageMode(mode.value)}
            className={`
              flex items-center gap-1 px-2 py-1 rounded text-xs font-medium
              transition-colors duration-150
              ${
                storageMode === mode.value
                  ? "bg-blue-600 text-white"
                  : "bg-slate-700 text-slate-300 hover:bg-slate-600"
              }
            `}
            title={mode.description}
          >
            <span>{mode.icon}</span>
            <span>{mode.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 컴팩트 버전 - 헤더 우상단 배치용
 *
 * 외곽선 버튼 스타일. 클릭으로 SSE ↔ Serendipity 전환.
 * 세렌디피티 서버가 설정되지 않은 경우 클릭에 반응하지 않음.
 */
export function StorageModeToggleCompact() {
  const storageMode = useDashboardStore((s) => s.storageMode);
  const setStorageMode = useDashboardStore((s) => s.setStorageMode);
  const serendipityAvailable = useDashboardStore((s) => s.serendipityAvailable);

  const currentMode = STORAGE_MODES.find((m) => m.value === storageMode);
  if (!currentMode) return null;

  const canToggle = serendipityAvailable;

  const handleClick = () => {
    if (!canToggle) return;
    const nextMode = storageMode === "sse" ? "serendipity" : "sse";
    setStorageMode(nextMode);
  };

  return (
    <button
      onClick={handleClick}
      disabled={!canToggle}
      className={cn(
        "flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-medium",
        "border transition-colors",
        canToggle
          ? "border-border text-muted-foreground hover:bg-input cursor-pointer"
          : "border-transparent text-muted-foreground/50 cursor-default",
      )}
      title={
        canToggle
          ? `현재: ${currentMode.label}\n클릭하여 전환`
          : currentMode.label
      }
    >
      <span className="text-[10px]">{currentMode.icon}</span>
      <span>{currentMode.label}</span>
    </button>
  );
}
