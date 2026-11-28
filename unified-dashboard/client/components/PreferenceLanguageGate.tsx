import { useEffect, useState, type ReactNode } from "react";
import { FrameLoading, useAuth } from "@seosoyoung/soul-ui";
import { fetchUserPreferences } from "@seosoyoung/soul-ui/lib/user-preferences";
import type { createI18n } from "@soulstream/i18n";

export function PreferenceLanguageGate({ children, i18n }: { children: ReactNode; i18n: ReturnType<typeof createI18n> }) {
  const { user } = useAuth();
  const email = user?.email ?? null;
  const [readyEmail, setReadyEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!email) return;
    let cancelled = false;
    fetchUserPreferences().then(({ preferences }) => {
      if (!cancelled && preferences.language) void i18n.changeLanguage(preferences.language);
    }).catch(() => undefined).finally(() => {
      if (!cancelled) setReadyEmail(email);
    });
    return () => { cancelled = true; };
  }, [email, i18n]);

  if (email && readyEmail !== email) return <FrameLoading />;
  return <>{children}</>;
}
