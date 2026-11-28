import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { AuthSurface, Button, Spinner } from "@seosoyoung/soul-ui";

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
  const { t } = useTranslation();
  const interaction = new URLSearchParams(window.location.search).get("interaction");
  const [view, setView] = useState<OAuthConsentView | null>(null);
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const actionInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!interaction) {
      setFailed(true);
      return;
    }
    let active = true;
    void request(`/api/oauth/interaction/${encodeURIComponent(interaction)}`, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as OAuthConsentView;
    }).then((consent) => {
      if (active) setView(consent);
    }).catch(() => {
      if (active) setFailed(true);
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
            <p className="text-sm text-muted-foreground">{t("sessions.consentLifetime")}</p>
            <form
              action={`/api/oauth/interaction/${encodeURIComponent(interaction ?? "")}`}
              method="post"
              className="flex gap-3"
              aria-busy={submitting !== null}
              onSubmit={(event) => {
                const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
                if (actionInput.current && submitter) {
                  actionInput.current.value = submitter.value;
                  setSubmitting(submitter.value);
                }
              }}
            >
              <input type="hidden" name="csrf" value={view.csrf} />
              <input ref={actionInput} type="hidden" name="action" />
              <Button className="flex-1" type="submit" value="allow" disabled={submitting !== null}>
                {submitting === "allow" && <Spinner aria-label={t("sessions.processing")} />}{t("sessions.allow")}
              </Button>
              <Button className="flex-1" type="submit" value="cancel" variant="outline" disabled={submitting !== null}>
                {submitting === "cancel" && <Spinner aria-label={t("sessions.processing")} />}{t("sessions.cancel")}
              </Button>
            </form>
          </>
        ) : failed ? (
          <div role="alert" className="flex flex-col gap-1 text-sm">
            <p className="text-accent-red">{t("sessions.consentLoadFailed")}</p>
            <p className="text-muted-foreground">{t("sessions.retrySignIn")}</p>
          </div>
        ) : null}
      </AuthSurface>
    </main>
  );
}
