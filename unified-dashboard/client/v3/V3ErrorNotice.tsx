import type { ReactNode } from "react";
import { safeErrorDetail } from "@seosoyoung/soul-ui/lib/safe-error-detail";

import "./v3-content-boundary.css";

export function V3ErrorNotice({
  message,
  detail,
  children,
  className,
}: {
  message: string;
  detail?: string | null;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={["v3-error-notice", className].filter(Boolean).join(" ")} role="alert">
      <strong>{message}</strong>
      <p>입력 내용과 연결 상태를 확인한 뒤 다시 시도하세요.</p>
      {detail ? (
        <details>
          <summary>기술 상세</summary>
          <pre>{safeErrorDetail(detail)}</pre>
        </details>
      ) : null}
      {children ? <div className="v3-error-notice-actions">{children}</div> : null}
    </div>
  );
}
