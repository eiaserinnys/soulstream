import { useRef, type ElementType, type ReactNode } from "react";
import { useGlassSurface } from "@seosoyoung/soul-ui";

/** 유리 표면 하나. webgl을 켜면 액체 유리 캔버스가 이 표면을 굴절시킨다. */
export function GlassPanel({ as: Tag = "div", webgl = false, className = "", children, ...props }: {
  as?: ElementType;
  webgl?: boolean;
  className?: string;
  children?: ReactNode;
  [key: string]: unknown;
}) {
  const ref = useRef<HTMLElement>(null);
  const active = useGlassSurface(ref, { enabled: webgl });
  return <Tag {...props} ref={ref}
    className={`glass-strong glass-chrome lg-rim ${className}`.trim()}
    data-liquid-glass-webgl={active ? "true" : undefined}>
    {children}
  </Tag>;
}
