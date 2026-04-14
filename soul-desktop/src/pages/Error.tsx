interface ErrorPageProps {
  message: string;
  onRetry: () => void;
  onChangeUrl: () => void;
}

export default function ErrorPage({ message, onRetry, onChangeUrl }: ErrorPageProps) {
  return (
    <div className="flex items-center justify-center min-h-screen p-8">
      <div className="w-full max-w-md text-center">
        <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-[var(--color-error)]/10 flex items-center justify-center">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              stroke="var(--color-error)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        <h1 className="text-xl font-bold mb-2">연결 실패</h1>
        <p className="text-[var(--color-text-muted)] mb-8">{message}</p>

        <div className="space-y-3">
          <button
            onClick={onRetry}
            className="w-full py-2.5 px-4 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white font-medium transition-colors"
          >
            다시 시도
          </button>
          <button
            onClick={onChangeUrl}
            className="w-full py-2.5 px-4 rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-surface)] font-medium transition-colors"
          >
            URL 변경
          </button>
        </div>
      </div>
    </div>
  );
}
