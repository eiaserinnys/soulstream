import "../client/globals.css";

import { createRoot } from "react-dom/client";

import { SessionMetadata } from "../../packages/soul-ui/src/components/detail/SessionMetadata";

const metadata = [
  {
    type: "caller_info",
    value: {
      source: "llm",
      agent_node: "eias-linegames-wsl",
      display_name: "External LLM",
      user_id: null,
      avatar_url: null,
    },
  },
  {
    type: "git_commit",
    value: "d6e68d41 external LLM caller",
  },
];

function Fixture() {
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <section
        className="mx-auto w-full max-w-[420px] overflow-hidden rounded-xl border border-border bg-card shadow-lg"
        data-testid="session-info-frame"
      >
        <header className="border-b border-border px-4 py-3">
          <div className="text-sm font-semibold">Session Info</div>
          <div className="mt-1 text-xs text-muted-foreground">
            외부 LLM 위임 세션
          </div>
        </header>
        <div className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-2 border-b border-border p-4 text-xs">
          <span className="text-muted-foreground">Status</span>
          <span>running</span>
          <span className="text-muted-foreground">Node</span>
          <span>eias-linegames-wsl</span>
        </div>
        <SessionMetadata metadata={metadata} />
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(<Fixture />);
