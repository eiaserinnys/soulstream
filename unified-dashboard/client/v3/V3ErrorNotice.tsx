import { Button } from "@seosoyoung/soul-ui";

import "./v3-content-boundary.css";

export function V3ErrorNotice({
  message,
  detail,
  onRetry,
  retryLabel = "다시 불러오기",
  className,
}: {
  message: string;
  detail?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div className={["v3-error-notice", className].filter(Boolean).join(" ")} role="alert">
      <strong data-v3-selectable-content="true">{message}</strong>
      {detail && detail !== message ? (
        <details>
          <summary>기술 상세</summary>
          <pre data-v3-selectable-content="true">{detail}</pre>
        </details>
      ) : null}
      {onRetry ? <div className="v3-error-notice-actions"><Button variant="outline" size="sm" onClick={onRetry}>{retryLabel}</Button></div> : null}
    </div>
  );
}
