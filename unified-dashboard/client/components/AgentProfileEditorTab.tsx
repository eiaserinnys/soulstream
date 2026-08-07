import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Button } from "@seosoyoung/soul-ui";

import { useOrchestratorStore } from "../store/orchestrator-store";

type AppliesWhenField = "source" | "node_id" | "container_kind" | "agent";
type AtomContextMode = "full" | "index" | "titles";

interface AgentAtomContext {
  node_id: string;
  depth?: number;
  titles_only?: boolean;
  include_ids?: boolean;
  mode?: AtomContextMode;
  applies_when?: Record<string, unknown>;
}

type AgentAlias = string | { id: string; default_preset?: string };

interface AgentProfile {
  agent_id: string;
  name: string;
  atom_contexts: AgentAtomContext[];
  default_preset: string | null;
  aliases: AgentAlias[];
  has_portrait: boolean;
  portrait: { mime: string; size: number; sha256: string } | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AliasDraft {
  id: string;
  default_preset: string;
}

interface ProfileDraft extends Omit<AgentProfile, "aliases"> {
  aliases: AliasDraft[];
}

interface ManifestSource {
  id: string;
  label: string;
  status: "ok" | "empty" | "error" | "filtered";
  chars: number;
  token_estimate: number;
}

const CONDITION_FIELDS: ReadonlyArray<{ field: AppliesWhenField; label: string }> = [
  { field: "source", label: "호출 소스" },
  { field: "node_id", label: "세션 노드" },
  { field: "container_kind", label: "컨테이너 종류" },
  { field: "agent", label: "에이전트" },
];

const VERSION_CONFLICT_MESSAGE =
  "다른 사용자가 먼저 수정했습니다. 최신 프로필을 다시 불러온 뒤 변경을 다시 적용하세요.";

export function AgentProfileEditorTab() {
  const nodes = useOrchestratorStore((state) => state.nodes);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [portraitFile, setPortraitFile] = useState<File | null>(null);
  const [removePortrait, setRemovePortrait] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [previewSource, setPreviewSource] = useState("browser");
  const [previewContainerKind, setPreviewContainerKind] = useState("task");
  const [previewSources, setPreviewSources] = useState<ManifestSource[]>([]);

  const connectedNodeIds = useMemo(
    () => Array.from(nodes.values())
      .filter((node) => node.status === "connected")
      .map((node) => node.nodeId),
    [nodes],
  );

  useEffect(() => {
    if (!selectedNodeId || !connectedNodeIds.includes(selectedNodeId)) {
      setSelectedNodeId(connectedNodeIds[0] ?? "");
    }
  }, [connectedNodeIds, selectedNodeId]);

  const loadProfiles = async (preferredAgentId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/agent-profiles", { credentials: "same-origin" });
      const body = await responseJson(response);
      if (!response.ok) throw new Error(responseMessage(body, "프로필을 불러오지 못했습니다."));
      const nextProfiles = Array.isArray(body.profiles) ? body.profiles as AgentProfile[] : [];
      setProfiles(nextProfiles);
      const selected = nextProfiles.find((profile) => profile.agent_id === preferredAgentId)
        ?? nextProfiles[0]
        ?? null;
      setDraft(selected ? profileDraft(selected) : null);
      setPortraitFile(null);
      setRemovePortrait(false);
      setPreviewSources([]);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProfiles();
  }, []);

  const selectProfile = (profile: AgentProfile) => {
    setDraft(profileDraft(profile));
    setMessage(null);
    setError(null);
    setPortraitFile(null);
    setRemovePortrait(false);
    setPreviewSources([]);
  };

  const startProfile = () => {
    const now = new Date().toISOString();
    setDraft({
      agent_id: "",
      name: "",
      atom_contexts: [],
      default_preset: null,
      aliases: [],
      has_portrait: false,
      portrait: null,
      version: 0,
      created_at: now,
      updated_at: now,
    });
    setMessage(null);
    setError(null);
    setPortraitFile(null);
    setRemovePortrait(false);
    setPreviewSources([]);
  };

  const save = async () => {
    if (!draft || !draft.agent_id.trim() || !draft.name.trim()) {
      setError("에이전트 ID와 이름을 입력하세요.");
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      let current = await putProfile(draft);
      setDraft(profileDraft(current));

      if (portraitFile) {
        if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(portraitFile.type)) {
          throw new Error("초상화는 PNG, JPEG, WebP, GIF만 지원합니다.");
        }
        current = await putPortrait(current, portraitFile);
      } else if (removePortrait && current.has_portrait) {
        current = await deletePortrait(current);
      }

      setProfiles((previous) => upsertProfile(previous, current));
      setDraft(profileDraft(current));
      setPortraitFile(null);
      setRemovePortrait(false);
      setMessage("프로필을 저장했습니다.");
    } catch (caught) {
      if (caught instanceof VersionConflictError) {
        setError(VERSION_CONFLICT_MESSAGE);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setSaving(false);
    }
  };

  const preview = async () => {
    if (!draft || !selectedNodeId) {
      setError("미리보기를 실행할 연결 노드를 선택하세요.");
      return;
    }
    setPreviewing(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/nodes/${encodeURIComponent(selectedNodeId)}/agents/context-preview`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            atom_contexts: draft.atom_contexts,
            session: {
              source: previewSource,
              container_kind: previewContainerKind,
              agent: draft.agent_id,
            },
          }),
        },
      );
      const body = await responseJson(response);
      if (!response.ok) throw new Error(responseMessage(body, "미리보기 컴파일에 실패했습니다."));
      setPreviewSources(Array.isArray(body.manifest?.sources) ? body.manifest.sources : []);
      setMessage("현재 편집 중인 명세로 dry-run을 완료했습니다.");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPreviewing(false);
    }
  };

  if (loading) return <div className="py-8 text-center text-sm text-muted-foreground">프로필을 불러오는 중...</div>;

  return (
    <div className="grid h-[520px] min-h-0 grid-cols-[13rem_minmax(0,1fr)] overflow-hidden rounded border border-border">
      <aside className="min-h-0 overflow-y-auto border-r border-border bg-muted/20 p-2">
        <Button type="button" size="sm" variant="outline" className="mb-2 w-full" onClick={startProfile}>
          새 프로필
        </Button>
        {profiles.map((profile) => (
          <button
            key={profile.agent_id}
            type="button"
            className={`mb-1 w-full rounded px-3 py-2 text-left text-sm ${draft?.agent_id === profile.agent_id ? "bg-accent-blue/15 text-foreground" : "text-muted-foreground hover:bg-muted"}`}
            onClick={() => selectProfile(profile)}
          >
            <span className="block font-semibold">{profile.name}</span>
            <span className="block truncate text-xs">{profile.agent_id} · v{profile.version}</span>
          </button>
        ))}
      </aside>

      <div className="min-h-0 overflow-y-auto p-4" data-testid="agent-profile-editor">
        {!draft ? (
          <div className="py-10 text-center text-sm text-muted-foreground">편집할 프로필을 선택하거나 새로 만드세요.</div>
        ) : (
          <div className="space-y-5">
            <section className="grid grid-cols-2 gap-3">
              <LabeledInput
                label="에이전트 ID"
                value={draft.agent_id}
                disabled={draft.version > 0}
                onChange={(value) => setDraft({ ...draft, agent_id: value })}
              />
              <LabeledInput label="이름" value={draft.name} onChange={(value) => setDraft({ ...draft, name: value })} />
              <LabeledInput
                label="기본 프리셋"
                value={draft.default_preset ?? ""}
                placeholder="미지정"
                onChange={(value) => setDraft({ ...draft, default_preset: value || null })}
              />
              <div>
                <label className="mb-1 block text-xs font-medium">초상화</label>
                <input
                  aria-label="초상화"
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="block w-full text-xs"
                  onChange={(event) => choosePortrait(event, setPortraitFile, setRemovePortrait)}
                />
                {draft.has_portrait && (
                  <label className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={removePortrait}
                      onChange={(event) => {
                        setRemovePortrait(event.target.checked);
                        if (event.target.checked) setPortraitFile(null);
                      }}
                    />
                    기존 초상화 삭제
                  </label>
                )}
              </div>
            </section>

            <section>
              <SectionHeading
                title="Atom 컨텍스트"
                actionLabel="소스 추가"
                onAction={() => setDraft({ ...draft, atom_contexts: [...draft.atom_contexts, { node_id: "", mode: "full" }] })}
              />
              <div className="space-y-3">
                {draft.atom_contexts.map((context, index) => (
                  <div key={`${index}-${context.node_id}`} className="rounded border border-border bg-muted/10 p-3">
                    <div className="grid grid-cols-[minmax(0,1fr)_7rem_5rem_auto] gap-2">
                      <LabeledInput
                        label="Atom node UUID"
                        value={context.node_id}
                        onChange={(value) => updateContext(draft, setDraft, index, { ...context, node_id: value })}
                      />
                      <label className="text-xs font-medium">
                        모드
                        <select
                          aria-label={`컨텍스트 ${index + 1} 모드`}
                          className={inputClassName}
                          value={context.mode ?? "full"}
                          onChange={(event) => updateContext(draft, setDraft, index, { ...context, mode: event.target.value as AtomContextMode })}
                        >
                          <option value="full">full</option>
                          <option value="index">index</option>
                          <option value="titles">titles</option>
                        </select>
                      </label>
                      <LabeledInput
                        label="깊이"
                        type="number"
                        min="0"
                        value={context.depth === undefined ? "" : String(context.depth)}
                        onChange={(value) => updateContext(draft, setDraft, index, {
                          ...context,
                          ...(value === "" ? withoutKey(context, "depth") : { depth: Number(value) }),
                        })}
                      />
                      <Button type="button" size="sm" variant="ghost" className="mt-5" onClick={() => setDraft({ ...draft, atom_contexts: draft.atom_contexts.filter((_, current) => current !== index) })}>
                        삭제
                      </Button>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
                      {CONDITION_FIELDS.map(({ field, label }) => (
                        <LabeledInput
                          key={field}
                          label={`조건 · ${label}`}
                          placeholder="쉼표로 OR"
                          value={conditionText(context.applies_when?.[field])}
                          onChange={(value) => updateContext(draft, setDraft, index, updateCondition(context, field, value))}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                {draft.atom_contexts.length === 0 && <p className="text-xs text-muted-foreground">등록된 컨텍스트 소스가 없습니다.</p>}
              </div>
            </section>

            <section>
              <SectionHeading
                title="별칭"
                actionLabel="별칭 추가"
                onAction={() => setDraft({ ...draft, aliases: [...draft.aliases, { id: "", default_preset: "" }] })}
              />
              <div className="space-y-2">
                {draft.aliases.map((alias, index) => (
                  <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
                    <LabeledInput label="별칭 ID" value={alias.id} onChange={(value) => updateAlias(draft, setDraft, index, { ...alias, id: value })} />
                    <LabeledInput label="별칭 프리셋" value={alias.default_preset} placeholder="기본값 상속" onChange={(value) => updateAlias(draft, setDraft, index, { ...alias, default_preset: value })} />
                    <Button type="button" size="sm" variant="ghost" className="mt-5" onClick={() => setDraft({ ...draft, aliases: draft.aliases.filter((_, current) => current !== index) })}>삭제</Button>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded border border-border p-3">
              <SectionHeading title="컴파일 미리보기" />
              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs font-medium">
                  실행 노드
                  <select aria-label="미리보기 실행 노드" className={inputClassName} value={selectedNodeId} onChange={(event) => setSelectedNodeId(event.target.value)}>
                    {connectedNodeIds.length === 0 && <option value="">연결된 노드 없음</option>}
                    {connectedNodeIds.map((nodeId) => <option key={nodeId} value={nodeId}>{nodeId}</option>)}
                  </select>
                </label>
                <label className="text-xs font-medium">
                  호출 소스
                  <select aria-label="미리보기 호출 소스" className={inputClassName} value={previewSource} onChange={(event) => setPreviewSource(event.target.value)}>
                    {["browser", "agent", "api", "channel_observer", "execute-proxy", "llm", "slack", "soul-app", "system", "trello_watcher"].map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
                <label className="text-xs font-medium">
                  컨테이너
                  <select aria-label="미리보기 컨테이너" className={inputClassName} value={previewContainerKind} onChange={(event) => setPreviewContainerKind(event.target.value)}>
                    <option value="task">task</option>
                    <option value="runbook">runbook</option>
                    <option value="folder">folder</option>
                  </select>
                </label>
              </div>
              <Button type="button" size="sm" variant="outline" className="mt-3" disabled={previewing || !selectedNodeId} onClick={() => void preview()}>
                {previewing ? "컴파일 중..." : "dry-run 실행"}
              </Button>
              {previewSources.length > 0 && (
                <div className="mt-3 overflow-x-auto" data-testid="context-preview-results">
                  <table className="w-full min-w-[32rem] text-left text-xs">
                    <thead><tr className="border-b border-border"><th className="py-1">소스</th><th>상태</th><th>자수</th><th>예상 토큰</th></tr></thead>
                    <tbody>{previewSources.map((source) => (
                      <tr key={source.id} className="border-b border-border/50">
                        <td className="py-1">{source.label || source.id}</td><td>{source.status}</td><td>{source.chars}</td><td>{source.token_estimate}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </section>

            {error && <p role="alert" className="rounded bg-accent-red/10 px-3 py-2 text-sm text-accent-red">{error}</p>}
            {message && <p role="status" className="rounded bg-accent-blue/10 px-3 py-2 text-sm">{message}</p>}
            <div className="flex justify-end gap-2">
              {error === VERSION_CONFLICT_MESSAGE && (
                <Button type="button" size="sm" variant="outline" onClick={() => void loadProfiles(draft.agent_id)}>최신 버전 다시 불러오기</Button>
              )}
              <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>{saving ? "저장 중..." : "프로필 저장"}</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const inputClassName = "mt-1 h-8 w-full rounded border border-border bg-background px-2 text-sm";

function LabeledInput({ label, value, onChange, ...props }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <label className="text-xs font-medium">
      {label}
      <input aria-label={label} className={inputClassName} value={value} onChange={(event) => onChange(event.target.value)} {...props} />
    </label>
  );
}

function SectionHeading({ title, actionLabel, onAction }: { title: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-sm font-semibold">{title}</h3>
      {actionLabel && <Button type="button" size="sm" variant="outline" onClick={onAction}>{actionLabel}</Button>}
    </div>
  );
}

function profileDraft(profile: AgentProfile): ProfileDraft {
  return {
    ...structuredClone(profile),
    aliases: profile.aliases.map((alias) => typeof alias === "string"
      ? { id: alias, default_preset: "" }
      : { id: alias.id, default_preset: alias.default_preset ?? "" }),
  };
}

function updateContext(draft: ProfileDraft, setDraft: (draft: ProfileDraft) => void, index: number, context: AgentAtomContext) {
  setDraft({ ...draft, atom_contexts: draft.atom_contexts.map((current, currentIndex) => currentIndex === index ? context : current) });
}

function updateAlias(draft: ProfileDraft, setDraft: (draft: ProfileDraft) => void, index: number, alias: AliasDraft) {
  setDraft({ ...draft, aliases: draft.aliases.map((current, currentIndex) => currentIndex === index ? alias : current) });
}

function updateCondition(context: AgentAtomContext, field: AppliesWhenField, text: string): AgentAtomContext {
  const appliesWhen = { ...(context.applies_when ?? {}) };
  const values = text.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length > 0) appliesWhen[field] = values;
  else delete appliesWhen[field];
  if (Object.keys(appliesWhen).length === 0) {
    const { applies_when: _removed, ...withoutCondition } = context;
    return withoutCondition;
  }
  return { ...context, applies_when: appliesWhen };
}

function conditionText(value: unknown): string {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").join(", ");
  return typeof value === "string" ? value : "";
}

function withoutKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

async function putProfile(draft: ProfileDraft): Promise<AgentProfile> {
  const response = await fetch(`/api/agent-profiles/${encodeURIComponent(draft.agent_id.trim())}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: draft.name.trim(),
      atom_contexts: draft.atom_contexts,
      default_preset: draft.default_preset || null,
      aliases: draft.aliases.filter((alias) => alias.id.trim()).map((alias) => alias.default_preset
        ? { id: alias.id.trim(), default_preset: alias.default_preset }
        : alias.id.trim()),
      expected_version: draft.version || null,
    }),
  });
  return profileResponse(response, "프로필 저장에 실패했습니다.");
}

async function putPortrait(profile: AgentProfile, file: File): Promise<AgentProfile> {
  const response = await fetch(`/api/agent-profiles/${encodeURIComponent(profile.agent_id)}/portrait`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data_base64: await fileBase64(file), mime: file.type, expected_version: profile.version }),
  });
  return profileResponse(response, "초상화 저장에 실패했습니다.");
}

async function deletePortrait(profile: AgentProfile): Promise<AgentProfile> {
  const response = await fetch(`/api/agent-profiles/${encodeURIComponent(profile.agent_id)}/portrait`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expected_version: profile.version }),
  });
  return profileResponse(response, "초상화 삭제에 실패했습니다.");
}

async function profileResponse(response: Response, fallback: string): Promise<AgentProfile> {
  const body = await responseJson(response);
  if (response.status === 409 || body.code === "agent_profile_version_conflict") throw new VersionConflictError();
  if (!response.ok) throw new Error(responseMessage(body, fallback));
  return body as AgentProfile;
}

class VersionConflictError extends Error {}

function responseMessage(body: Record<string, any>, fallback: string): string {
  return typeof body.detail === "string"
    ? body.detail
    : typeof body.error?.message === "string"
      ? body.error.message
      : fallback;
}

async function responseJson(response: Response): Promise<Record<string, any>> {
  try {
    return await response.json() as Record<string, any>;
  } catch {
    return {};
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "요청 처리에 실패했습니다.";
}

function upsertProfile(profiles: AgentProfile[], profile: AgentProfile): AgentProfile[] {
  const without = profiles.filter((current) => current.agent_id !== profile.agent_id);
  return [...without, profile].sort((left, right) => left.agent_id.localeCompare(right.agent_id));
}

function choosePortrait(
  event: ChangeEvent<HTMLInputElement>,
  setFile: (file: File | null) => void,
  setRemove: (remove: boolean) => void,
) {
  setFile(event.target.files?.[0] ?? null);
  setRemove(false);
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("초상화 파일을 읽지 못했습니다."));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}
