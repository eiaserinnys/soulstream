import { useEffect, useState } from "react";
import { AuthSurface, Button } from "@seosoyoung/soul-ui";

type OAuthConsentView = {
  readonly email: string;
  readonly clientName: string;
  readonly permissions: string;
  readonly csrf: string;
};

type OAuthConsentPageProps = {
  readonly request?: typeof fetch;
};

export function OAuthConsentPage({ request = fetch }: OAuthConsentPageProps) {
  const interaction = new URLSearchParams(window.location.search).get("interaction");
  const [view, setView] = useState<OAuthConsentView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!interaction) {
      setError("동의를 불러오지 못했습니다.");
      return;
    }
    let active = true;
    void request(`/api/oauth/interaction/${encodeURIComponent(interaction)}`, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    }).then(async (response) => {
      if (!response.ok) throw new Error("동의를 불러오지 못했습니다.");
      return await response.json() as OAuthConsentView;
    }).then((consent) => {
      if (active) setView(consent);
    }).catch(() => {
      if (active) setError("동의를 불러오지 못했습니다.");
    });
    return () => { active = false; };
  }, [interaction, request]);

  return (
    <main className="flex items-center justify-center min-h-screen bg-background">
      <AuthSurface>
        {view ? (
          <>
            <h1 className="text-xl font-bold text-foreground">{view.clientName}</h1>
            <p className="text-sm text-muted-foreground">{view.email}</p>
            <p className="text-sm text-foreground">{view.permissions}</p>
            <p className="text-sm text-muted-foreground">30일 안에 쓰면 계속 이어짐</p>
            <form
              action={`/api/oauth/interaction/${encodeURIComponent(interaction ?? "")}`}
              method="post"
              className="flex gap-3"
            >
              <input type="hidden" name="csrf" value={view.csrf} />
              <Button className="flex-1" type="submit" name="action" value="allow">허용</Button>
              <Button className="flex-1" type="submit" name="action" value="cancel" variant="outline">취소</Button>
            </form>
          </>
        ) : error ? (
          <p className="text-sm text-accent-red" role="alert">{error}</p>
        ) : null}
      </AuthSurface>
    </main>
  );
}
