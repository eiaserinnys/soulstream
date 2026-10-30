import type { PropsWithChildren } from "react";

export function AuthSurface({ children }: PropsWithChildren) {
  return (
    <div className="mx-4 w-full min-w-0 max-w-sm break-words bg-card border border-border rounded-xl p-8 shadow-lg flex flex-col gap-6">
      {children}
    </div>
  );
}
