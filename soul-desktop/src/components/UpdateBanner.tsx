import { useState, useCallback } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { startInstall, relaunchApp } from "../utils/updater";

type BannerState = "available" | "downloading" | "ready" | "error";

interface UpdateBannerProps {
  update: Update;
  onDismiss: () => void;
}

export default function UpdateBanner({ update, onDismiss }: UpdateBannerProps) {
  const [state, setState] = useState<BannerState>("available");
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");

  const handleInstall = useCallback(async () => {
    setState("downloading");
    setProgress(0);
    let downloaded = 0;

    try {
      await startInstall(update, (chunkLength, contentLength) => {
        downloaded += chunkLength;
        if (contentLength > 0) {
          setProgress(Math.min(100, Math.round((downloaded / contentLength) * 100)));
        }
      });
      setState("ready");
    } catch (e) {
      console.error("Update install failed:", e);
      setErrorMessage(
        e instanceof Error ? e.message : "알 수 없는 오류가 발생했습니다.",
      );
      setState("error");
    }
  }, [update]);

  const handleRelaunch = useCallback(async () => {
    try {
      await relaunchApp();
    } catch (e) {
      console.error("Relaunch failed:", e);
      setErrorMessage("앱 재시작에 실패했습니다. 수동으로 재시작해 주세요.");
      setState("error");
    }
  }, []);

  return (
    <div className="fixed top-0 left-0 right-0 z-50 px-4 py-3 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
      <div className="max-w-2xl mx-auto flex items-center gap-3">
        {state === "available" && (
          <>
            <span className="text-sm flex-1">
              새 버전 <strong className="text-[var(--color-primary)]">{update.version}</strong>이
              있습니다.
            </span>
            <button
              onClick={handleInstall}
              className="px-3 py-1.5 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-sm font-medium transition-colors"
            >
              지금 업데이트
            </button>
            <button
              onClick={onDismiss}
              className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm hover:bg-[var(--color-bg)] transition-colors"
            >
              나중에
            </button>
          </>
        )}

        {state === "downloading" && (
          <>
            <span className="text-sm shrink-0">업데이트 다운로드 중...</span>
            <div className="flex-1 h-2 rounded-full bg-[var(--color-bg)] overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--color-primary)] transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-sm text-[var(--color-text-muted)] shrink-0 w-10 text-right">
              {progress}%
            </span>
          </>
        )}

        {state === "ready" && (
          <>
            <span className="text-sm flex-1 text-[var(--color-success)]">
              업데이트 설치 완료. 재시작하면 적용됩니다.
            </span>
            <button
              onClick={handleRelaunch}
              className="px-3 py-1.5 rounded-lg bg-[var(--color-success)] hover:brightness-110 text-white text-sm font-medium transition-all"
            >
              재시작
            </button>
          </>
        )}

        {state === "error" && (
          <>
            <span className="text-sm flex-1 text-[var(--color-error)]">
              업데이트 실패: {errorMessage || "다음 실행 시 다시 시도합니다."}
            </span>
            <button
              onClick={onDismiss}
              className="p-1 rounded hover:bg-[var(--color-bg)] transition-colors"
              title="닫기"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 4L12 12M12 4L4 12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
