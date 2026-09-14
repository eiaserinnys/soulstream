import { useEffect, useMemo, useState } from "react";
import { Button } from "@seosoyoung/soul-ui";

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

export function SessionReviewPolicyTab() {
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
      const response = await fetch(ENDPOINT, { credentials: "same-origin" });
      const body = await readJson(response);
      if (!response.ok) throw new Error(apiMessage(body, "검수 정책을 불러오지 못했습니다."));
      const next = body as PolicyPayload;
      setPayload(next);
      setSources(next.policy.sourceAllowlist);
      setMessage(options.conflict
        ? "다른 관리자가 먼저 저장해 최신 정책을 다시 불러왔습니다. 변경 내용을 확인해 주세요."
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
      setError("browser는 목록이 아니라 아래 신원 조건부 정책으로 항상 처리됩니다.");
      return;
    }
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(source)) {
      setError("출처 ID는 소문자, 숫자, 하이픈, 밑줄로 1~64자여야 합니다.");
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
      const response = await fetch(ENDPOINT, {
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
      if (!response.ok) throw new Error(apiMessage(body, "검수 정책을 저장하지 못했습니다."));
      const next = body as PolicyPayload;
      setPayload(next);
      setSources(next.policy.sourceAllowlist);
      setMessage(`정책 v${next.policy.version}를 저장했습니다. 새로 만드는 세션부터 모든 노드에 적용됩니다.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  if (loading && !payload) {
    return <div className="py-8 text-center text-sm text-muted-foreground">검수 정책을 불러오는 중...</div>;
  }

  return (
    <div className="space-y-4" data-testid="session-review-policy-tab">
      <section className="rounded-lg border border-border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold">브라우저 요청</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          로그인한 브라우저 요청은 항상 검수합니다. 이 항목은 따로 설정할 필요가 없습니다.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          새로 만드는 세션부터 모든 노드에 적용됩니다. 실행 중이거나 완료된 세션은 바뀌지 않습니다.
        </p>
      </section>

      <section
        className="space-y-3 rounded-lg border border-border p-4"
        aria-busy={saving}
      >
        <div>
          <h3 className="text-sm font-semibold">검수할 출처</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            선택한 출처에서 새로 만드는 세션은 실행이 끝나면 검수 목록에 표시됩니다.
            이 설정은 검수 여부만 바꿉니다.
          </p>
        </div>

        <div className="space-y-2" data-testid="session-review-policy-sources">
          {sources.length === 0 && (
            <div className="rounded border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
              로그인한 브라우저 요청 외에 검수할 출처가 없습니다.
            </div>
          )}
          {sources.map((source) => {
            const entry = catalog.get(source);
            return (
              <div key={source} className="flex items-start justify-between gap-3 rounded border border-border px-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {entry?.label ?? source} <code className="ml-1 text-xs text-muted-foreground">{source}</code>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {entry?.description ?? "사용자 정의 출처"}
                    {entry?.automatic ? " 자동으로 시작되는 요청이 포함될 수 있으므로 추가 전에 확인하세요." : ""}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`${source} 제거`}
                  disabled={loading || saving}
                  onClick={() => setSources((current) => current.filter((item) => item !== source))}
                >
                  제거
                </Button>
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={draft}
            list="session-review-source-catalog"
            aria-label="추가할 출처 ID"
            placeholder="예: external-llm"
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
            추가
          </Button>
        </div>
        {saving && (
          <p className="text-xs text-muted-foreground" role="status">
            정책을 저장하는 동안에는 출처를 수정할 수 없습니다.
          </p>
        )}
      </section>

      {payload && (
        <div className="text-xs text-muted-foreground">
          현재 v{payload.policy.version}. 마지막 수정: {payload.policy.updatedBy}, {formatTimestamp(payload.policy.updatedAt)}
        </div>
      )}
      {message && <div className="rounded bg-accent-blue/10 px-3 py-2 text-sm">{message}</div>}
      {error && <div className="rounded bg-accent-red/10 px-3 py-2 text-sm text-accent-red">{error}</div>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={loading || saving} onClick={() => void load()}>
          다시 불러오기
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!changed || saving || loading}
          data-testid="session-review-policy-save"
          onClick={() => void save()}
        >
          {saving ? "저장 중..." : "정책 저장"}
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

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toLocaleString() : value;
}
