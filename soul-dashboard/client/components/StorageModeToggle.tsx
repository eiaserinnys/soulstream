/**
 * StorageModeToggle - 스토리지 모드 전환 UI
 *
 * SSE 모드(Soul Server API + SSE 실시간)와 Serendipity 모드 사이를 전환합니다.
 */

import { useDashboardStore } from "../stores/dashboard-store";
import type { StorageMode } from "../providers/types";

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
 * 컴팩트 버전 - 헤더 등 좁은 공간용
 */
export function StorageModeToggleCompact() {
  const storageMode = useDashboardStore((s) => s.storageMode);
  const setStorageMode = useDashboardStore((s) => s.setStorageMode);

  const currentMode = STORAGE_MODES.find((m) => m.value === storageMode);
  const nextMode = STORAGE_MODES.find((m) => m.value !== storageMode);

  if (!currentMode || !nextMode) return null;

  return (
    <button
      onClick={() => setStorageMode(nextMode.value)}
      className="flex items-center gap-1 px-2 py-1 rounded text-xs
                 bg-slate-700 text-slate-300 hover:bg-slate-600
                 transition-colors duration-150"
      title={`현재: ${currentMode.label} (${currentMode.description})\n클릭하여 ${nextMode.label}로 전환`}
    >
      <span>{currentMode.icon}</span>
      <span className="text-slate-400">→</span>
      <span>{nextMode.icon}</span>
    </button>
  );
}
