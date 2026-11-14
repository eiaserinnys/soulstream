import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type {
  IsolationHostPorts,
  IsolationPreparationInput,
  MountBinding,
  WorktreeAttachment,
} from "../security/session_isolation_contract.js";
import {
  IsolationPreparationPolicyError,
  SessionIsolationUnavailableError,
} from "./session_filesystem_errors.js";

/** 원본과 공유 RW로 여는 git common 하위 디렉터리. */
const SHARED_GIT_DIRECTORIES = ["objects", "refs", "logs", "worktrees"] as const;
/** 원본을 RO로만 보는 git common 하위 디렉터리. */
const READ_ONLY_GIT_DIRECTORIES = ["hooks", "info"] as const;

const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface PrepareGitViewArgs {
  input: IsolationPreparationInput;
  ports: IsolationHostPorts;
  sandboxDirectory: string;
}

async function requireDirectory(
  ports: IsolationHostPorts,
  path: string,
  label: string,
): Promise<string> {
  if (!isAbsolute(path)) {
    throw new SessionIsolationUnavailableError(`${label} 경로가 절대 경로가 아닙니다`);
  }
  const fact = await ports.lstatPath(path);
  if (!fact || fact.kind !== "directory") {
    throw new SessionIsolationUnavailableError(`${label} 디렉터리를 찾을 수 없습니다: ${path}`);
  }
  return ports.resolveRealPath(path);
}

async function resolveCommonDirectory(
  input: IsolationPreparationInput,
  ports: IsolationHostPorts,
  repoId: string,
  repositoryPath: string,
  attachments: readonly WorktreeAttachment[],
): Promise<string> {
  // common dir는 worktree 레코드 값을 믿지 않고 호스트 사실로 resolve한다
  // (스펙 §8, worktree_git.ts의 resolve). 선언값이 있으면 일치만 확인한다.
  const resolved = await ports.resolveGitCommonDir(repositoryPath);
  const attachment = attachments.find((candidate) => candidate.repoId === repoId);
  const declared = attachment?.commonDir;
  if (declared) {
    if (!isAbsolute(declared)) {
      throw new IsolationPreparationPolicyError(
        `worktree commonDir가 절대 경로가 아닙니다: ${repoId}`,
      );
    }
    let declaredReal: string;
    try {
      declaredReal = await ports.resolveRealPath(declared);
    } catch {
      throw new IsolationPreparationPolicyError(
        `worktree commonDir를 확인할 수 없습니다: ${repoId}`,
      );
    }
    if (declaredReal !== resolved) {
      throw new IsolationPreparationPolicyError(
        `worktree commonDir가 해석값과 다릅니다: ${repoId}`,
      );
    }
  }
  return resolved;
}

/**
 * §8 Git view. `<sandbox>/git-common/<repo-id>/`에 세션 전용 외곽을 만들고
 * 원본 common-dir 위치에 bind한다. 공유 디렉터리만 RW이고 config/HEAD는
 * 세션 사본이며, Upstream 설정·hook·info·packed-refs는 원본 RO다.
 */
export async function prepareGitView(
  args: PrepareGitViewArgs,
): Promise<MountBinding[]> {
  const { input, ports, sandboxDirectory } = args;
  const bindings: MountBinding[] = [];
  const registered = new Set<string>();
  const attachments = [...input.ownedWorktrees, ...input.attachedWorktrees];

  for (const attachment of attachments) {
    if (!input.registeredRepositories.some((repo) => repo.repoId === attachment.repoId)) {
      throw new IsolationPreparationPolicyError(
        `등록되지 않은 리포의 워크트리입니다: ${attachment.repoId}`,
      );
    }
  }

  for (const repository of input.registeredRepositories) {
    if (!REPOSITORY_ID_PATTERN.test(repository.repoId)) {
      throw new IsolationPreparationPolicyError(
        `repoId에 사용할 수 없는 문자가 있습니다: ${repository.repoId}`,
      );
    }
    if (registered.has(repository.repoId)) {
      throw new IsolationPreparationPolicyError(
        `repoId가 중복되었습니다: ${repository.repoId}`,
      );
    }
    registered.add(repository.repoId);

    await requireDirectory(ports, repository.canonicalPath, "등록 리포");
    const commonDirectory = await resolveCommonDirectory(
      input,
      ports,
      repository.repoId,
      repository.canonicalPath,
      attachments,
    );
    if (!isAbsolute(commonDirectory)) {
      throw new SessionIsolationUnavailableError(
        "git common 디렉터리 경로가 절대 경로가 아닙니다",
      );
    }
    const commonDirectoryReal = await requireDirectory(
      ports,
      commonDirectory,
      "git common",
    );

    const viewRoot = join(sandboxDirectory, "git-common", repository.repoId);
    await ports.ensureDirectory(viewRoot, 0o700);
    const viewRootReal = await ports.resolveRealPath(viewRoot);

    // 전용 view를 원래 common-dir 절대 위치에 올린다.
    bindings.push({
      source: viewRootReal,
      destination: commonDirectory,
      writable: true,
    });

    for (const name of SHARED_GIT_DIRECTORIES) {
      const hostPath = join(commonDirectoryReal, name);
      const fact = await ports.lstatPath(hostPath);
      if (!fact) {
        // 새 repo에는 logs/worktrees가 없을 수 있다. 원본에 미리 만든다.
        await ports.ensureDirectory(hostPath, 0o700);
      } else if (fact.kind !== "directory") {
        throw new SessionIsolationUnavailableError(
          `git common 항목이 디렉터리가 아닙니다: ${hostPath}`,
        );
      }
      const source = await ports.resolveRealPath(hostPath);
      bindings.push({
        source,
        destination: join(commonDirectory, name),
        writable: true,
      });
    }

    for (const name of READ_ONLY_GIT_DIRECTORIES) {
      const hostPath = join(commonDirectoryReal, name);
      const fact = await ports.lstatPath(hostPath);
      if (!fact || fact.kind !== "directory") continue;
      const source = await ports.resolveRealPath(hostPath);
      bindings.push({
        source,
        destination: join(commonDirectory, name),
        writable: false,
      });
    }

    const packedRefs = join(commonDirectoryReal, "packed-refs");
    const packedRefsFact = await ports.lstatPath(packedRefs);
    if (packedRefsFact?.kind === "file") {
      const source = await ports.resolveRealPath(packedRefs);
      bindings.push({
        source,
        destination: join(commonDirectory, "packed-refs"),
        writable: false,
      });
    }

    // 기본 체크아웃의 색인. 상자 안 git이 호스트 색인을 읽기 전용으로 본다.
    // 호스트에 index가 없으면 바인딩을 만들지 않고, bwrap이 파일 bind의
    // 목적지에 남긴 0바이트 자리 파일을 지운다. 0바이트 index는 git을
    // fatal로 멈춘다.
    const index = join(commonDirectoryReal, "index");
    const indexFact = await ports.lstatPath(index);
    if (indexFact?.kind === "file") {
      const source = await ports.resolveRealPath(index);
      bindings.push({
        source,
        destination: join(commonDirectory, "index"),
        writable: false,
      });
    } else {
      await rm(join(viewRootReal, "index"), { force: true });
    }

    // 세션 전용 외곽 값. upstream 설정은 이 사본에만 저장된다.
    const config = join(commonDirectoryReal, "config");
    const configFact = await ports.lstatPath(config);
    if (!configFact || configFact.kind !== "file") {
      throw new SessionIsolationUnavailableError(
        `git config를 찾을 수 없습니다: ${config}`,
      );
    }
    await ports.copyFile(config, join(viewRootReal, "config"), 0o600);

    const head = join(commonDirectoryReal, "HEAD");
    const headFact = await ports.lstatPath(head);
    if (!headFact || headFact.kind !== "file") {
      throw new SessionIsolationUnavailableError(`git HEAD를 찾을 수 없습니다: ${head}`);
    }
    await ports.copyFile(head, join(viewRootReal, "HEAD"), 0o644);
  }

  return bindings;
}
