import { Loader2Icon } from "lucide-react";
import { cn } from "../../lib/cn";

interface SpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  /** "default" = rotating circle (Loader2Icon), "bar" = 8-bar activity indicator */
  variant?: "default" | "bar";
}

/**
 * 8-bar activity indicator (iOS-style spinner).
 * Each bar fades in sequence via a shared @keyframes animation with staggered delays.
 */
function BarSpinner({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const bars = 8;
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn("relative inline-block", className)}
      {...props}
    >
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className="absolute left-1/2 top-0 h-[30%] w-[12%] -translate-x-1/2 rounded-full bg-current"
          style={{
            transform: `rotate(${i * (360 / bars)}deg) translateX(-50%)`,
            transformOrigin: "50% calc(100% / 0.3)",
            opacity: 0.15,
            animation: `bar-spinner-fade 0.8s linear ${(i / bars).toFixed(2)}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes bar-spinner-fade {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.15; }
        }
      `}</style>
    </div>
  );
}

function Spinner({ variant = "default", className, ...props }: SpinnerProps) {
  if (variant === "bar") {
    return <BarSpinner className={className} {...props} />;
  }

  return (
    <Loader2Icon
      aria-label="Loading"
      className={cn("animate-spin", className)}
      role="status"
      {...(props as React.ComponentProps<typeof Loader2Icon>)}
    />
  );
}

export { Spinner };
