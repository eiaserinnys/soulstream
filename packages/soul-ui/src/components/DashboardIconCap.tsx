import { forwardRef, useCallback, useRef, type ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/cn";
import { useLiquidLens } from "../lib/liquid-lens";
import { useGlassSurface } from "./LiquidGlassProvider";

export interface DashboardIconCapProps
  extends Omit<ComponentPropsWithoutRef<"button">, "aria-label" | "title"> {
  label: string;
  tooltip?: string;
  size?: "default" | "small";
  appearance?: "default" | "bare";
}

/** v1 글로벌 툴바의 설정·테마 버튼과 동일한 아이콘 액션 정본. */
export const DashboardIconCap = forwardRef<HTMLButtonElement, DashboardIconCapProps>(function DashboardIconCap({
  label,
  tooltip,
  size = "default",
  appearance = "default",
  className,
  children,
  type = "button",
  ...props
}, forwardedRef) {
  const bare = appearance === "bare";
  const ref = useRef<HTMLButtonElement | null>(null);
  const setRef = useCallback((button: HTMLButtonElement | null) => {
    ref.current = button;
    if (typeof forwardedRef === "function") forwardedRef(button);
    else if (forwardedRef) forwardedRef.current = button;
  }, [forwardedRef]);
  const webglActive = useGlassSurface(ref, { enabled: !bare });
  useLiquidLens(ref, { scale: 22, enabled: !bare && !webglActive });

  return (
    <button
      {...props}
      ref={setRef}
      type={type}
      className={cn(
        "dashboard-icon-cap",
        bare
          ? "dashboard-icon-cap--bare"
          : "border border-glass-border glass-strong glass-chrome lg-rim",
        size === "small" && "dashboard-icon-cap--small",
        className,
      )}
      data-slot="dashboard-icon-cap"
      data-appearance={bare ? "bare" : undefined}
      data-liquid-glass-webgl={webglActive ? "true" : undefined}
      aria-label={label}
      title={tooltip ?? label}
    >
      {children}
    </button>
  );
});
