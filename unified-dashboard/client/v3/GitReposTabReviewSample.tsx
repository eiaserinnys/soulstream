import { useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NodeGitCloneJob, NodeGitSetupSnapshot } from "../../../packages/wire-schema/generated/typescript/index";
import { GitReposTab } from "../components/GitReposTab";
import type { OrchestratorNode } from "../store/orchestrator-store";

const KEY_PATH = "/home/eias/.ssh/id_ed25519";
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK3vQ9wZr2m0lXb7s8dYhT4nUe1PqRcJf6aGoWkVxMiN soulstream@sample-node-a";
const LONG_NAME = "soulstream-repository-with-an-extremely-long-folder-name-that-is-allowed-up-to-one-hundred-chars-xyz";
const LONG_URL = "https://git.example.invalid/organization-with-long-name/team-with-long-name/project-with-long-name/repository-with-long-name.git";

const ready: NodeGitSetupSnapshot = {
  identity: { name: "서소영", email: "soyoung@example.invalid" },
  ssh: { state: "ready", key_path: KEY_PATH, public_key: PUBLIC_KEY },
  projects: {
    state: "ready",
    root: "/home/eias/workspace/.projects",
    repos: [
      { name: "soulstream", origin_url: "git@github.com:example/soulstream.git", branch: "main", dirty: true },
      { name: "atom", origin_url: "https://github.com/example/atom.git", branch: "feat/card-1909-git-setup", dirty: false },
    ],
  },
  clone: null,
};
const withSsh = (ssh: NodeGitSetupSnapshot["ssh"], base = ready): NodeGitSetupSnapshot => ({ ...base, ssh });
const withProjects = (projects: NodeGitSetupSnapshot["projects"]): NodeGitSetupSnapshot => ({ ...ready, projects });
const job = (patch: Partial<NodeGitCloneJob>): NodeGitCloneJob => ({
  clone_id: "sample-clone", repo_name: "atom-next", url: "https://github.com/example/atom-next.git", state: "running",
  error: null, started_at: "2026-11-27T00:00:00.000Z", finished_at: null, ...patch,
});
const worst: NodeGitSetupSnapshot = {
  identity: { name: "가".repeat(100), email: `${"a".repeat(60)}@${"b".repeat(60)}.example.invalid` },
  ssh: { state: "ready", key_path: "/home/an-account-with-a-long-name/.ssh/id_ed25519", public_key: `${PUBLIC_KEY} ${"comment-".repeat(14)}` },
  projects: {
    state: "ready",
    root: "/home/an-account-with-a-long-name/workspace/a-very-deep-folder/another-deep-folder/.projects",
    repos: Array.from({ length: 30 }, (_, index) => ({
      name: index === 0 ? LONG_NAME : `repository-${index + 1}`,
      origin_url: index % 2 === 0 ? LONG_URL : null,
      branch: index % 3 === 0 ? "feature/a-branch-name-that-keeps-going-and-going-and-going" : "main",
      dirty: index % 4 === 0,
    })),
  },
  clone: null,
};

const connected = (nodeId: string, capabilities: Record<string, unknown> = { node_git_setup_v1: true }): OrchestratorNode =>
  ({ nodeId, host: "sample.invalid", port: 0, status: "connected", capabilities, connectedAt: 0, sessionCount: 0 });
const down = (nodeId: string): OrchestratorNode => ({ ...connected(nodeId), status: "disconnected" });

type Behavior = {
  status?: NodeGitSetupSnapshot | "pending" | "failed";
  sshKey?: NodeGitSetupSnapshot;
  sshCheck?: { ok: boolean; reason: string; output: string };
  cloneStatus?: NodeGitCloneJob;
};
type Scene = { id: string; label: string; nodes: OrchestratorNode[]; behavior: Behavior };

const SCENES: readonly Scene[] = [
  { id: "ready", label: "준비 · 키 있음 · 저장소 2개", nodes: [connected("sample-node-a")], behavior: { status: ready, sshCheck: { ok: true, reason: "connected", output: "Hi example! You've successfully authenticated, but GitHub does not provide shell access." } } },
  { id: "unset-no-key", label: "사용자 미설정 · 키 없음 (만들기를 누르면 키가 나타남)", nodes: [connected("sample-node-a")], behavior: {
    status: { ...withSsh({ state: "missing", key_path: KEY_PATH, public_key: null }), identity: { name: null, email: null } },
    sshKey: ready,
  } },
  { id: "public-missing", label: "공개키 파일 없음", nodes: [connected("sample-node-a")], behavior: { status: withSsh({ state: "public_missing", key_path: KEY_PATH, public_key: null }) } },
  { id: "root-unset", label: "저장소 폴더 미설정", nodes: [connected("sample-node-a")], behavior: { status: withProjects({ state: "root_unset", root: null, repos: [] }) } },
  { id: "root-missing", label: "저장소 폴더 없음", nodes: [connected("sample-node-a")], behavior: { status: withProjects({ state: "root_missing", root: "/home/eias/workspace/.projects", repos: [] }) } },
  { id: "loading", label: "불러오는 중", nodes: [connected("sample-node-a")], behavior: { status: "pending" } },
  { id: "read-failed", label: "읽기 실패 · 다시 불러오기", nodes: [connected("sample-node-a")], behavior: { status: "failed" } },
  { id: "node-down", label: "노드 끊김", nodes: [down("sample-node-a")], behavior: {} },
  { id: "node-old", label: "구버전 노드", nodes: [connected("sample-node-a", {})], behavior: {} },
  { id: "clone-running", label: "가져오는 중", nodes: [connected("sample-node-a")], behavior: {
    status: { ...ready, clone: job({}) }, cloneStatus: job({}),
  } },
  { id: "clone-failed", label: "가져오기 실패 · 비공개 저장소를 https로", nodes: [connected("sample-node-a")], behavior: {
    status: { ...ready, clone: job({}) },
    cloneStatus: job({ state: "failed", finished_at: "2026-11-27T00:00:03.000Z", error: { code: "auth_failed", message: "Authentication failed", detail: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" } }),
  } },
  { id: "ssh-ok", label: "연결 확인 성공 (연결 확인을 누르면)", nodes: [connected("sample-node-a")], behavior: {
    status: ready, sshCheck: { ok: true, reason: "connected", output: "Hi example! You've successfully authenticated, but GitHub does not provide shell access." },
  } },
  { id: "ssh-failed", label: "연결 확인 실패 (연결 확인을 누르면)", nodes: [connected("sample-node-a")], behavior: {
    status: ready, sshCheck: { ok: false, reason: "auth_failed", output: "git@github.com: Permission denied (publickey)." },
  } },
  { id: "worst", label: "최악 데이터 · 100자 이름 · 긴 주소와 노드 ID · 저장소 30개", nodes: [connected("sample-node-with-a-very-long-identifier-that-should-be-truncated-in-the-list-and-the-header-abcdefghijklmnopqrstuvwxyz"), connected("sample-node-b")], behavior: { status: worst } },
];

function fakeRequest(behavior: Behavior, delayMs: number): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (method === "GET" && /\/git$/.test(path)) {
      if (behavior.status === "pending") return new Promise<Response>(() => undefined);
      if (behavior.status === "failed" || behavior.status === undefined) return Response.json({ code: "node_command_timeout", message: "x" }, { status: 502 });
      return Response.json(behavior.status);
    }
    if (method === "PUT") return Response.json(behavior.status);
    if (path.endsWith("/ssh-key")) return Response.json(behavior.sshKey, { status: 201 });
    if (path.endsWith("/ssh-check")) return Response.json({ host: "github.com", ...behavior.sshCheck });
    if (method === "POST" && path.endsWith("/clones")) return Response.json(job({}), { status: 202 });
    if (path.includes("/clones/")) return Response.json(behavior.cloneStatus ?? job({}));
    return Response.json({ code: "sample_route_missing", message: "x" }, { status: 404 });
  }) as typeof fetch;
}

function GitReposScene({ scene, delayMs }: { scene: Scene; delayMs: number }) {
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);
  const request = useMemo(() => fakeRequest(scene.behavior, delayMs), [scene, delayMs]);
  const nodes = useMemo(() => new Map(scene.nodes.map((node) => [node.nodeId, node])), [scene]);
  return <div data-review-scene={scene.id}>
    <p className="v3-components-label">{scene.label}</p>
    <div className="rounded-floor border border-border p-3" data-testid="git-repos-tab-review">
      <QueryClientProvider client={client}><GitReposTab request={request} sampleNodes={nodes} /></QueryClientProvider>
    </div>
  </div>;
}

/** 설정창 「Git과 저장소」 탭의 장면들. scene을 주면 그 장면 하나만 그린다. delayMs는 눌렀을 때 응답이 늦는 상태(바쁜 단추)를 보려는 값이다. */
export function GitReposTabReviewSample({ scene, delayMs = 0 }: { scene?: string | null; delayMs?: number }) {
  return <div className="space-y-3" data-testid="git-repos-review">
    {SCENES.filter((item) => !scene || item.id === scene).map((item) => <GitReposScene key={item.id} scene={item} delayMs={delayMs} />)}
  </div>;
}
