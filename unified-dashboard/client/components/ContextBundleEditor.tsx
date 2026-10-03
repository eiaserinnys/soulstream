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

const VERSION_CONFLICT_MESSAGE =
  "다른 사용자가 먼저 수정했습니다. 최신 번들을 다시 불러온 뒤 변경을 다시 적용하세요.";

export function ContextBundleEditor({ bundles, onBundlesChanged, request = fetch }: {
  request?: typeof fetch;
  bundles: ContextBundle[];
  onBundlesChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<ContextBundle | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      setError("번들 ID를 입력하세요.");
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
      if (!response.ok) throw new Error(responseMessage(body, "번들 저장에 실패했습니다."));
      setDraft(body as ContextBundle);
      await onBundlesChanged();
      setMessage("번들을 저장했습니다.");
    } catch (caught) {
      setError(caught instanceof VersionConflictError ? VERSION_CONFLICT_MESSAGE : errorMessage(caught));
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
          ? `이 번들을 참조하는 프로필: ${referencedBy}`
          : responseMessage(body, "번들 삭제에 실패했습니다."));
      }
      setDraft(null);
      await onBundlesChanged();
      setMessage("번들을 삭제했습니다.");
    } catch (caught) {
      setError(caught instanceof VersionConflictError ? VERSION_CONFLICT_MESSAGE : errorMessage(caught));
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
      if (!response.ok) throw new Error(responseMessage(body, "번들을 불러오지 못했습니다."));
      setDraft(body as ContextBundle);
      await onBundlesChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <div className="grid h-[520px] min-h-0 grid-cols-[13rem_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded border border-border">
      <header className="col-span-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">컨텍스트 번들</h2>
        <p className="mt-1 text-xs text-muted-foreground">여러 프로필이 함께 쓰는 atom 컨텍스트 묶음입니다. 여기서 번들을 만들고 고치면, 각 프로필의 「컨텍스트 번들」 절에서 참조합니다. 참조 중인 번들은 삭제할 수 없습니다.</p>
      </header>
      <aside className="min-h-0 overflow-y-auto border-r border-border bg-muted/20 p-2">
        <Button type="button" size="sm" variant="outline" className="mb-2 w-full" onClick={startBundle}>
          새 번들
        </Button>
        {bundles.map((bundle) => (
          <button
            key={bundle.bundle_id}
            type="button"
            aria-label={bundle.bundle_id}
            className={`mb-1 w-full rounded px-3 py-2 text-left text-sm ${draft?.bundle_id === bundle.bundle_id ? "bg-accent-blue/15 text-foreground" : "text-muted-foreground hover:bg-muted"}`}
            onClick={() => selectBundle(bundle)}
          >
            <span className="block font-semibold">{bundle.bundle_id}</span>
            <span className="block truncate text-xs">{bundle.description || "설명 없음"} · v{bundle.version}</span>
          </button>
        ))}
      </aside>

      <div className="min-h-0 overflow-y-auto p-4" data-testid="context-bundle-editor">
        {!draft ? (
          <div className="py-10 text-center text-sm text-muted-foreground">편집할 번들을 선택하거나 새로 만드세요.</div>
        ) : (
          <div className="space-y-5">
            <section className="grid grid-cols-2 gap-3">
              <LabeledInput
                label="번들 ID"
                value={draft.bundle_id}
                disabled={draft.version > 0}
                onChange={(value) => setDraft({ ...draft, bundle_id: value })}
              />
              <LabeledInput
                label="설명"
                value={draft.description}
                onChange={(value) => setDraft({ ...draft, description: value })}
              />
            </section>
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Atom 컨텍스트</h3>
                <Button type="button" size="sm" variant="outline" onClick={() => setDraft({
                  ...draft,
                  atom_contexts: [...draft.atom_contexts, { node_id: "", mode: "full" }],
                })}>소스 추가</Button>
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
                {draft.atom_contexts.length === 0 && <p className="text-xs text-muted-foreground">등록된 컨텍스트 소스가 없습니다.</p>}
              </div>
            </section>
            <div className="flex justify-end gap-2">
              {error === VERSION_CONFLICT_MESSAGE && (
                <Button type="button" size="sm" variant="outline" onClick={() => void reloadLatest()}>최신 버전 다시 불러오기</Button>
              )}
              {draft.version > 0 && (
                <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void remove()}>번들 삭제</Button>
              )}
              <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>{saving ? "저장 중..." : "번들 저장"}</Button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="mt-3 rounded bg-accent-red/10 px-3 py-2 text-sm text-accent-red">{error}</p>}
        {message && <p role="status" className="mt-3 rounded bg-accent-blue/10 px-3 py-2 text-sm">{message}</p>}
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "요청 처리에 실패했습니다.";
}
