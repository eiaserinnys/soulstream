import type { SessionProviderConnectionStatus } from "@seosoyoung/soul-ui";

export function SessionStreamStatus({
  active,
  status,
  reconnect,
}: {
  active: boolean;
  status: SessionProviderConnectionStatus;
  reconnect(): void;
}) {
  if (!active || status !== "error") return null;
  const message = "연결 오류 · 다시 연결";
  return (
    <button
      type="button"
      className="v3-chat-status v3-chat-status--error v3-session-stream-retry"
      data-testid="v3-session-stream-retry"
      aria-label={message}
      onClick={reconnect}
    >
      {message}
    </button>
  );
}
