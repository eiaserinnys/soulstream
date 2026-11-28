import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  if (!active || status !== "error") return null;
  const message = t("sessions.reconnect");
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
