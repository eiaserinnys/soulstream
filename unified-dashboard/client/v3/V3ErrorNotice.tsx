import type { ReactNode } from "react";

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
      {detail ? (
        <details>
          <summary>세부 정보</summary>
          <pre>{detail}</pre>
        </details>
      ) : null}
      {children ? <div className="v3-error-notice-actions">{children}</div> : null}
    </div>
  );
}
