import { useTranslation } from "react-i18next";
import { useState } from "react";
import { Button } from "@seosoyoung/soul-ui";

import { AgentAtomContextFields, LabeledInput, type AgentAtomContext } from "./AgentAtomContextFields";

export interface ContextBundle {
  bundle_id: string;
  description: string;
  atom_contexts: AgentAtomContext[];
  version: number;
  created_at: string;
  updated_at: string;
}


export function ContextBundleEditor({ bundles, onBundlesChanged, request = fetch }: {
  request?: typeof fetch;
  bundles: ContextBundle[];
  onBundlesChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ContextBundle | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | VersionConflictError | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selectBundle = (bundle: ContextBundle) => {
    setDraft(structuredClone(bundle));
    setError(null);
    setMessage(null);
  };

  const startBundle = () => {
    setDraft({
      bundle_id: "",
      description: "",
      atom_contexts: [],
      version: 0,
      created_at: "",
      updated_at: "",
    });
    setError(null);
    setMessage(null);
  };

  const save = async () => {
    if (!draft?.bundle_id.trim()) {
      setError(t("agents.bundle.idRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await request(`/api/context-bundles/${encodeURIComponent(draft.bundle_id.trim())}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: draft.description,
          atom_contexts: draft.atom_contexts,
          expected_version: draft.version || null,
        }),
      });
      const body = await responseJson(response);
      if (body.code === "context_bundle_version_conflict") throw new VersionConflictError();
      if (!response.ok) throw new Error(responseMessage(body, t("agents.bundle.saveError")));
      setDraft(body as ContextBundle);
      await onBundlesChanged();
      setMessage(t("agents.bundle.saved"));
    } catch (caught) {
      setError(caught instanceof VersionConflictError ? caught : errorMessage(caught, t("agents.requestError")));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft || draft.version === 0) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await request(`/api/context-bundles/${encodeURIComponent(draft.bundle_id)}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected_version: draft.version }),
      });
      const body = await responseJson(response);
      if (body.code === "context_bundle_version_conflict") throw new VersionConflictError();
      if (!response.ok) {
        const referencedBy = Array.isArray(body.referenced_by) ? body.referenced_by.join(", ") : "";
        throw new Error(referencedBy
          ? t("agents.bundle.referencedBy", { profiles: referencedBy })
          : responseMessage(body, t("agents.bundle.deleteError")));
      }
      setDraft(null);
      await onBundlesChanged();
      setMessage(t("agents.bundle.deleted"));
    } catch (caught) {
      setError(caught instanceof VersionConflictError ? caught : errorMessage(caught, t("agents.requestError")));
    } finally {
      setSaving(false);
    }
  };

  const reloadLatest = async () => {
    if (!draft) return;
    setError(null);
    try {
      const response = await request(`/api/context-bundles/${encodeURIComponent(draft.bundle_id)}`, {
        credentials: "same-origin",
      });
      const body = await responseJson(response);
      if (!response.ok) throw new Error(responseMessage(body, t("agents.bundle.loadError")));
      setDraft(body as ContextBundle);
      await onBundlesChanged();
    } catch (caught) {
      setError(errorMessage(caught, t("agents.requestError")));
    }
  };

  return (
    <div className="grid h-[520px] min-h-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_minmax(0,2fr)] overflow-hidden rounded-floor border border-border sm:h-auto sm:flex-1 sm:grid-cols-[13rem_minmax(0,1fr)] sm:grid-rows-[auto_minmax(0,1fr)]">
      <header className="border-b border-border px-4 py-3 sm:col-span-2">
        <h2 className="text-sm font-semibold">{t("agents.bundle.title")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("agents.bundle.help")}</p>
      </header>
      <aside className="min-h-0 overflow-y-auto border-r border-border bg-muted/20 p-2">
        <Button type="button" size="sm" variant="outline" className="mb-2 w-full" onClick={startBundle}>
          {t("agents.bundle.new")}
        </Button>
        {bundles.map((bundle) => (
          <button
            key={bundle.bundle_id}
            type="button"
            aria-label={bundle.bundle_id}
            className={`mb-1 w-full rounded-floor px-3 py-2 text-left text-sm ${draft?.bundle_id === bundle.bundle_id ? "bg-accent-blue/15 text-foreground" : "text-muted-foreground hover:bg-muted"}`}
            onClick={() => selectBundle(bundle)}
          >
            <span className="block font-semibold">{bundle.bundle_id}</span>
            <span className="block truncate text-xs">{bundle.description || t("agents.bundle.noDescription")} · v{bundle.version}</span>
          </button>
        ))}
      </aside>

      <div className="min-h-0 overflow-y-auto overscroll-contain p-4" data-testid="context-bundle-editor">
        {!draft ? (
          <div className="py-10 text-center text-sm text-muted-foreground">{t("agents.bundle.empty")}</div>
        ) : (
          <div className="space-y-5">
            <section className="grid grid-cols-2 gap-3">
              <LabeledInput
                label={t("agents.bundle.id")}
                value={draft.bundle_id}
                disabled={draft.version > 0}
                onChange={(value) => setDraft({ ...draft, bundle_id: value })}
              />
              <LabeledInput
                label={t("agents.bundle.description")}
                value={draft.description}
                onChange={(value) => setDraft({ ...draft, description: value })}
              />
            </section>
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">{t("agents.context.atom")}</h3>
                <Button type="button" size="sm" variant="outline" onClick={() => setDraft({
                  ...draft,
                  atom_contexts: [...draft.atom_contexts, { node_id: "", mode: "full" }],
                })}>{t("agents.context.addSource")}</Button>
              </div>
              <div className="space-y-3">
                {draft.atom_contexts.map((context, index) => (
                  <AgentAtomContextFields
                    key={index}
                    context={context}
                    index={index}
                    onChange={(next) => setDraft({
                      ...draft,
                      atom_contexts: draft.atom_contexts.map((current, currentIndex) => currentIndex === index ? next : current),
                    })}
                    onRemove={() => setDraft({
                      ...draft,
                      atom_contexts: draft.atom_contexts.filter((_, currentIndex) => currentIndex !== index),
                    })}
                  />
                ))}
                {draft.atom_contexts.length === 0 && <p className="text-xs text-muted-foreground">{t("agents.context.noSources")}</p>}
              </div>
            </section>
            <div className="flex justify-end gap-2">
              {error instanceof VersionConflictError && (
                <Button type="button" size="sm" variant="outline" onClick={() => void reloadLatest()}>{t("agents.reloadLatest")}</Button>
              )}
              {draft.version > 0 && (
                <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void remove()}>{t("agents.bundle.delete")}</Button>
              )}
              <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>{saving ? t("agents.saving") : t("agents.bundle.save")}</Button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="mt-3 rounded-floor bg-accent-red/10 px-3 py-2 text-sm text-destructive-foreground">{error instanceof VersionConflictError ? t("agents.bundle.conflict") : error}</p>}
        {message && <p role="status" className="mt-3 rounded-floor bg-accent-blue/10 px-3 py-2 text-sm">{message}</p>}
      </div>
    </div>
  );
}

class VersionConflictError extends Error {}

async function responseJson(response: Response): Promise<Record<string, any>> {
  try {
    return await response.json() as Record<string, any>;
  } catch {
    return {};
  }
}

function responseMessage(body: Record<string, any>, fallback: string): string {
  return typeof body.detail === "string" ? body.detail : fallback;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
