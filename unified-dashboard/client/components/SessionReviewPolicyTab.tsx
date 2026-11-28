import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FrameLoading } from "@seosoyoung/soul-ui";

type Policy = {
  key: string;
  sourceAllowlist: string[];
  version: number;
  updatedAt: string;
  updatedBy: string;
};

type SourceCatalogEntry = {
  source: string;
  label: string;
  description: string;
  automatic: boolean;
};

type PolicyPayload = {
  policy: Policy;
  conditionalRules: Array<{
    source: string;
    label: string;
    description: string;
    condition: string;
  }>;
  sourceCatalog: SourceCatalogEntry[];
};

const ENDPOINT = "/api/admin/settings/session-review-policy";

export function SessionReviewPolicyTab({ request = fetch }: { request?: typeof fetch } = {}) {
  const { t, i18n } = useTranslation();
  const [payload, setPayload] = useState<PolicyPayload | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const catalog = useMemo(
    () => new Map(payload?.sourceCatalog.map((entry) => [entry.source, entry]) ?? []),
    [payload?.sourceCatalog],
  );
  const changed = payload !== null
    && JSON.stringify(sources) !== JSON.stringify(payload.policy.sourceAllowlist);

  async function load(options: { conflict?: boolean } = {}) {
    setLoading(true);
    setError(null);
    try {
      const response = await request(ENDPOINT, { credentials: "same-origin" });
      const body = await readJson(response);
      if (!response.ok) throw new Error(apiMessage(body, t("jobs.review.loadError")));
      const next = body as PolicyPayload;
      setPayload(next);
      setSources(next.policy.sourceAllowlist);
      setMessage(options.conflict
        ? t("jobs.review.conflict")
        : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function addSource() {
    if (loading || saving) return;
    const source = draft.trim().toLowerCase();
    if (!source) return;
    if (source === "browser") {
      setError(t("jobs.review.browserAlreadyReviewed"));
      return;
    }
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(source)) {
      setError(t("jobs.review.invalidSource"));
      return;
    }
    setSources((current) => current.includes(source) ? current : [...current, source]);
    setDraft("");
    setError(null);
    setMessage(null);
  }

  async function save() {
    if (!payload || !changed || loading || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await request(ENDPOINT, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceAllowlist: sources,
          expectedVersion: payload.policy.version,
        }),
      });
      const body = await readJson(response);
      if (response.status === 409) {
        await load({ conflict: true });
        return;
      }
      if (!response.ok) throw new Error(apiMessage(body, t("jobs.review.saveError")));
      const next = body as PolicyPayload;
      setPayload(next);
      setSources(next.policy.sourceAllowlist);
      setMessage(t("jobs.review.saved", { version: next.policy.version }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  if (loading && !payload) {
    return <FrameLoading label={t("jobs.review.loading")} />;
  }

  return (
    <div className="space-y-4" data-testid="session-review-policy-tab">
      <section className="rounded-floor border border-border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold">{t("jobs.review.browserRequests")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("jobs.review.browserHelp")}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("jobs.review.appliesToNewSessions")}
        </p>
      </section>

      <section
        className="space-y-3 rounded-floor border border-border p-4"
        aria-busy={saving}
      >
        <div>
          <h3 className="text-sm font-semibold">{t("jobs.review.sources")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("jobs.review.sourcesHelp")}
          </p>
        </div>

        <div className="space-y-2" data-testid="session-review-policy-sources">
          {sources.length === 0 && (
            <div className="rounded-floor border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
              {t("jobs.review.noAdditionalSources")}
            </div>
          )}
          {sources.map((source) => {
            const entry = catalog.get(source);
            return (
              <div key={source} className="flex items-start justify-between gap-3 rounded-floor border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {entry?.label ?? source} <code className="ml-1 text-xs text-muted-foreground">{source}</code>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {entry?.description ?? t("jobs.review.customSource")}
                    {entry?.automatic ? t("jobs.review.automaticSource") : ""}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t("jobs.review.removeSource", { source })}
                  disabled={loading || saving}
                  onClick={() => setSources((current) => current.filter((item) => item !== source))}
                >
                  {t("jobs.common.remove")}
                </Button>
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="min-w-0 flex-1 rounded-floor border border-border bg-background px-3 py-2 text-sm"
            value={draft}
            list="session-review-source-catalog"
            aria-label={t("jobs.review.sourceId")}
            placeholder={t("jobs.review.sourceExample")}
            disabled={loading || saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addSource();
              }
            }}
          />
          <datalist id="session-review-source-catalog">
            {payload?.sourceCatalog.map((entry) => (
              <option key={entry.source} value={entry.source}>{entry.label}</option>
            ))}
          </datalist>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading || saving}
            onClick={addSource}
          >
            {t("jobs.common.add")}
          </Button>
        </div>
        {saving && (
          <p className="text-xs text-muted-foreground" role="status">
            {t("jobs.review.sourcesLocked")}
          </p>
        )}
      </section>

      {payload && (
        <div className="text-xs text-muted-foreground">
          {t("jobs.review.versionUpdated", { version: payload.policy.version, editor: payload.policy.updatedBy, time: formatTimestamp(payload.policy.updatedAt, i18n.resolvedLanguage) })}
        </div>
      )}
      {message && <div className="rounded-floor bg-accent-blue/10 px-3 py-2 text-sm">{message}</div>}
      {error && <div className="rounded-floor bg-accent-red/10 px-3 py-2 text-sm text-destructive-foreground" data-v3-selectable-content="true">{error}</div>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={loading || saving} onClick={() => void load()}>
          {t("jobs.common.reload")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!changed || saving || loading}
          data-testid="session-review-policy-save"
          onClick={() => void save()}
        >
          {saving ? t("jobs.common.savingLegacy") : t("jobs.review.save")}
        </Button>
      </div>
    </div>
  );
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function apiMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") return fallback;
  const detail = (value as Record<string, unknown>).detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const error = (detail as Record<string, unknown>).error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
  }
  return fallback;
}

function formatTimestamp(value: string, locale: string | undefined): string {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toLocaleString(locale) : value;
}
