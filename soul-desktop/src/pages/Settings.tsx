import { useState, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { normalizeUrl } from "../utils/url";

interface SettingsProps {
  currentUrl: string;
  onSave: (url: string) => void;
  onBack: () => void;
}

export default function Settings({ currentUrl, onSave, onBack }: SettingsProps) {
  const [urlInput, setUrlInput] = useState(currentUrl);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("unknown"));
  }, []);

  function handleSave() {
    setError("");
    try {
      const fullUrl = normalizeUrl(urlInput);
      onSave(fullUrl);
    } catch {
      setError("올바른 URL 형식이 아닙니다.");
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen p-8">
      <div className="w-full max-w-md">
        <div className="flex items-center mb-8">
          <button
            onClick={onBack}
            className="mr-3 p-1.5 rounded-lg hover:bg-[var(--color-surface)] transition-colors"
            title="뒤로"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <h1 className="text-2xl font-bold">설정</h1>
        </div>

        <div className="space-y-6">
          <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <h2 className="text-sm font-medium text-[var(--color-text-muted)] mb-3">
              연결
            </h2>

            {editing ? (
              <div className="space-y-3">
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => {
                    setUrlInput(e.target.value);
                    setError("");
                  }}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                  autoFocus
                />
                {error && (
                  <p className="text-sm text-[var(--color-error)]">{error}</p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={handleSave}
                    disabled={!urlInput.trim()}
                    className="flex-1 py-2 px-3 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    저장 및 연결
                  </button>
                  <button
                    onClick={() => {
                      setUrlInput(currentUrl);
                      setEditing(false);
                      setError("");
                    }}
                    className="py-2 px-3 rounded-lg border border-[var(--color-border)] text-sm hover:bg-[var(--color-bg)] transition-colors"
                  >
                    취소
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-sm truncate mr-3">{currentUrl}</span>
                <button
                  onClick={() => setEditing(true)}
                  className="shrink-0 text-sm text-[var(--color-primary)] hover:text-[var(--color-primary-hover)] transition-colors"
                >
                  수정
                </button>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <h2 className="text-sm font-medium text-[var(--color-text-muted)] mb-3">
              정보
            </h2>
            <div className="flex items-center justify-between">
              <span className="text-sm">버전</span>
              <span className="text-sm text-[var(--color-text-muted)]">
                {version || "..."}
              </span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
