import type { PropsWithChildren } from "react";

export function AuthSurface({ children }: PropsWithChildren) {
  return (
    <div className="w-full max-w-sm bg-card border border-border rounded-xl p-8 shadow-lg flex flex-col gap-6">
      {children}
    </div>
  );
}
