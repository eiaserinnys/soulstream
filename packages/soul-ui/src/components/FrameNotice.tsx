import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

export interface FrameNoticeProps extends HTMLAttributes<HTMLDivElement> {
  /** 내용 높이로 정해지는 좁은 자리에서 쓰는 한 줄 모양. */
  inline?: boolean;
}

/**
 * 실패 안내가 로더와 같은 자리에 서도록 쓰는 공통 자리.
 *
 * FrameLoading 과 같은 기하(패딩, 최소 높이, 가운데 정렬)를 쓴다. 채움 프레임에서는
 * 남은 높이를 채우고, 내용 높이 프레임에서는 로더와 같은 최소 높이를 지켜 로딩에서
 * 실패로 바뀔 때 뒤따르는 구역이 움직이지 않는다. 안내 자체의 role(alert 등)은
 * 자식이 그대로 유지한다.
 */
export function FrameNotice({
  inline = false,
  className,
  children,
  ...props
}: FrameNoticeProps) {
  return (
    <div
      data-slot="frame-notice"
      data-inline={inline || undefined}
      className={cn("v3-frame-seat", "v3-frame-notice", className)}
      {...props}
    >
      {children}
    </div>
  );
}
