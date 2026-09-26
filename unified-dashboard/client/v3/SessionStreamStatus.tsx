import type { SessionProviderConnectionStatus } from "@seosoyoung/soul-ui";

export function SessionStreamStatus({
  status,
  reconnect,
}: {
  status: SessionProviderConnectionStatus;
  reconnect(): void;
}) {
  if (status === "connected" || status === "connecting") return null;
  const message = status === "error" ? "연결 오류 · 다시 연결" : "연결 끊김 · 다시 연결";
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
