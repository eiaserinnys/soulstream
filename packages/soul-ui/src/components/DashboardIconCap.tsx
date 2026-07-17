import { useRef, type ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/cn";
import { useLiquidLens } from "../lib/liquid-lens";
import { useGlassSurface } from "./LiquidGlassProvider";

export interface DashboardIconCapProps
  extends Omit<ComponentPropsWithoutRef<"button">, "aria-label" | "title"> {
  label: string;
  tooltip?: string;
}

/** v1 글로벌 툴바의 설정·테마 버튼과 동일한 아이콘 액션 정본. */
export function DashboardIconCap({
  label,
  tooltip,
  className,
  children,
  type = "button",
  ...props
}: DashboardIconCapProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const webglActive = useGlassSurface(ref, { enabled: true });
  useLiquidLens(ref, { scale: 22, enabled: !webglActive });

  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={cn(
        "dashboard-icon-cap border border-glass-border glass-strong glass-chrome lg-rim",
        className,
      )}
      data-slot="dashboard-icon-cap"
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
      aria-label={label}
      title={tooltip ?? label}
    >
      {children}
    </button>
  );
}
