import { useState } from "react";
import { normalizeUrl, checkReachability } from "../utils/url";

interface SetupProps {
  onConnect: (url: string) => void;
  onSettings?: () => void;
}

export default function Setup({ onConnect, onSettings }: SetupProps) {
  const [urlInput, setUrlInput] = useState("");
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    let fullUrl: string;
    try {
      fullUrl = normalizeUrl(urlInput);
    } catch {
      setError("올바른 URL 형식이 아닙니다.");
      return;
    }

    setConnecting(true);
    try {
      await checkReachability(fullUrl, 5000);
      onConnect(fullUrl);
    } catch {
      setError("서버에 연결할 수 없습니다. URL을 확인해 주세요.");
      setConnecting(false);
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen p-8">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold mb-2">Soulstream</h1>
          <p className="text-[var(--color-text-muted)]">
            서버 URL을 입력하여 시작하세요.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="server-url"
              className="block text-sm font-medium mb-1.5"
            >
              서버 URL
            </label>
            <div className="flex">
              <span className="inline-flex items-center px-3 rounded-l-lg border border-r-0 border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] text-sm">
                https://
              </span>
              <input
                id="server-url"
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="your-server.example.com"
                className="flex-1 px-3 py-2 rounded-r-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] transition-colors"
                disabled={connecting}
                autoFocus
              />
            </div>
          </div>

          {error && (
            <p className="text-sm text-[var(--color-error)]">{error}</p>
          )}

          <button
            type="submit"
            disabled={connecting || !urlInput.trim()}
            className="w-full py-2.5 px-4 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {connecting ? "연결 중..." : "연결"}
          </button>
        </form>

        {onSettings && (
          <div className="mt-6 text-center">
            <button
              onClick={onSettings}
              className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            >
              설정
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
