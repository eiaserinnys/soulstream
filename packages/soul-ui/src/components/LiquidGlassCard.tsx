import { forwardRef, type CSSProperties, type HTMLAttributes } from "react";
import LiquidGlass from "liquid-glass-react";

import { cn } from "../lib/cn";

export interface LiquidGlassCardProps extends HTMLAttributes<HTMLDivElement> {
  cornerRadius?: number;
}

export function liquidGlassStyle(
  cornerRadius: number,
  style?: CSSProperties,
): CSSProperties {
  return {
    "--liquid-glass-radius": `${cornerRadius}px`,
    ...style,
  } as CSSProperties;
}

function isFirefoxOrSafari(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  const isFirefox = ua.includes("firefox");
  const isSafari =
    ua.includes("safari") &&
    !ua.includes("chrome") &&
    !ua.includes("chromium") &&
    !ua.includes("android") &&
    !ua.includes("edg/");
  return isFirefox || isSafari;
}

export function supportsLiquidGlassEnhancement(): boolean {
  if (typeof navigator === "undefined" || isFirefoxOrSafari(navigator.userAgent)) {
    return false;
  }
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
    return false;
  }
  return (
    CSS.supports("backdrop-filter", "blur(1px)") ||
    CSS.supports("-webkit-backdrop-filter", "blur(1px)")
  );
}

export function LiquidGlassLayer({
  cornerRadius = 18,
  enhanced = supportsLiquidGlassEnhancement(),
}: {
  cornerRadius?: number;
  enhanced?: boolean;
}) {
  if (!enhanced) return null;

  return (
    <div className="liquid-glass-card__layer" aria-hidden="true">
      <LiquidGlass
        className="liquid-glass-card__effect"
        displacementScale={28}
        blurAmount={0.02}
        saturation={125}
        aberrationIntensity={0.8}
        elasticity={0.03}
        cornerRadius={cornerRadius}
        padding="0"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          transform: "none",
        }}
      >
        <span className="liquid-glass-card__fill" />
      </LiquidGlass>
    </div>
  );
}

export const LiquidGlassCard = forwardRef<HTMLDivElement, LiquidGlassCardProps>(
  function LiquidGlassCard(
    { children, className, cornerRadius = 18, style, ...props },
    ref,
  ) {
    const enhanced = supportsLiquidGlassEnhancement();

    return (
      <div
        ref={ref}
        {...props}
        data-liquid-glass-enhanced={enhanced ? "true" : "false"}
        className={cn("liquid-glass-card", className)}
        style={liquidGlassStyle(cornerRadius, style)}
      >
        <LiquidGlassLayer cornerRadius={cornerRadius} enhanced={enhanced} />
        {children}
      </div>
    );
  },
);
