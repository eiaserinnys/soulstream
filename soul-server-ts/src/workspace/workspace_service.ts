import { realpath, stat } from "node:fs/promises";
import type { AgentRegistry } from "../agent_registry.js";
import type { WorktreeService } from "../worktree/worktree_service.js";
import { WorkspaceSnapshotCache } from "./workspace_snapshot.js";
import { diffWorkspaceFile } from "./workspace_file_diff.js";
import { readWorkspaceFile } from "./workspace_file_read.js";

export type WorkspaceTarget = {session_id: string; agent_id: string; worktree_id: string | null};
export class WorkspaceService {
  private readonly roots = new Map<string, {root: string; until: number}>();
  private readonly snapshots = new WorkspaceSnapshotCache();
  constructor(private readonly agents: AgentRegistry, private readonly worktrees?: Pick<WorktreeService,"resolveExecutionWorkspace">) {}
  async root(target: WorkspaceTarget): Promise<string> {
    const key=JSON.stringify([target.session_id,target.agent_id,target.worktree_id]);
    const cached=this.roots.get(key); if(cached && cached.until > Date.now()) return cached.root;
    let root: string | undefined;
    try { root=target.worktree_id ? await this.worktrees?.resolveExecutionWorkspace(target.worktree_id) : this.agents.get(target.agent_id)?.workspace_dir; }
    catch { throw new Error("NOT_FOUND: workspace unavailable"); }
    if(!root) throw new Error("NOT_FOUND: workspace unavailable");
    const resolved=await realpath(root).catch(()=>{throw new Error("NOT_FOUND: workspace unavailable");});
    if(!(await stat(resolved)).isDirectory()) throw new Error("NOT_FOUND: workspace unavailable");
    this.roots.set(key,{root:resolved,until:Date.now()+300_000}); return resolved;
  }
  async snapshot(target: WorkspaceTarget, since: string) { return this.snapshots.get(await this.root(target),since); }
  private async checkedRoot(target:WorkspaceTarget, expectedRoot?:string) {
    const root=await this.root(target);
    const same=process.platform === "win32" ? root.toLowerCase() === expectedRoot?.toLowerCase() : root === expectedRoot;
    if (expectedRoot !== undefined && !same) throw new Error("CONFLICT: workspace root changed");
    return root;
  }
  async diff(target: WorkspaceTarget, file: string, orig: string | null, expectedRoot?:string) { return diffWorkspaceFile(await this.checkedRoot(target,expectedRoot), file, orig); }
  async read(target: WorkspaceTarget, file: string, offset?: number, length?: number, expectedRoot?:string) { return readWorkspaceFile(await this.checkedRoot(target,expectedRoot),file,offset,length); }
}
const services = new WeakMap<object, WorkspaceService>();
export function registerWorkspaceService(runtime: object, service: WorkspaceService): void { services.set(runtime, service); }
export function workspaceServiceFor(runtime: object | undefined, agents: AgentRegistry, worktrees?: Pick<WorktreeService,"resolveExecutionWorkspace">): WorkspaceService {
  if (!runtime) return new WorkspaceService(agents, worktrees);
  let service = services.get(runtime);
  if (!service) { service = new WorkspaceService(agents, worktrees); services.set(runtime, service); }
  return service;
}
