import { useTranslation } from "react-i18next";
import { Button } from "@seosoyoung/soul-ui";

import "./v3-content-boundary.css";

export function V3ErrorNotice({
  message,
  detail,
  onRetry,
  retryLabel,
  className,
}: {
  message: string;
  detail?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={["v3-error-notice", className].filter(Boolean).join(" ")} role="alert">
      <strong data-v3-selectable-content="true">{message}</strong>
      {detail && detail !== message ? (
        <details>
          <summary>{t("sessions.technicalDetails")}</summary>
          <pre data-v3-selectable-content="true">{detail}</pre>
        </details>
      ) : null}
      {onRetry ? <div className="v3-error-notice-actions"><Button variant="outline" size="sm" onClick={onRetry}>{retryLabel ?? t("sessions.reload")}</Button></div> : null}
    </div>
  );
}
