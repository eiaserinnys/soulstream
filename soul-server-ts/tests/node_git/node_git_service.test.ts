import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { NodeGitService } from "../../src/node_git/node_git_service.js";
import {
  NodeGitServiceError,
  deriveRepoName,
  parseCloneUrl,
  parseHost,
  parseIdentity,
  parseRepoName,
} from "../../src/node_git/node_git_validation.js";
import {
  GitProcessError,
  runBoundedProcess,
  type BoundedProcessInput,
  type BoundedProcessResult,
} from "../../src/worktree/worktree_process.js";
import { makeTempDirSync } from "../helpers/temp_dir.js";

type Fake = (input: BoundedProcessInput) => Promise<BoundedProcessResult>;

function ok(stdout = "", stderr = "", exitCode = 0): BoundedProcessResult {
  return { stdout, stderr, exitCode };
}

function setup(options: { withProjects?: boolean; fake?: Fake } = {}) {
  const home = makeTempDirSync("node-git-home-");
  const projectsRoot = options.withProjects === false ? null : makeTempDirSync("node-git-projects-");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  } as NodeJS.ProcessEnv;
  const calls: BoundedProcessInput[] = [];
  const fake = options.fake ?? (async () => ok());
  const processRunner = async (input: BoundedProcessInput): Promise<BoundedProcessResult> => {
    const isSsh = input.command === "ssh";
    const isClone = input.command === "git" && input.args[0] === "clone";
    if (isSsh || isClone) {
      calls.push(input);
      return await fake(input);
    }
    return await runBoundedProcess(input);
  };
  const service = new NodeGitService({ nodeId: "node-a", homeDir: home, projectsRoot, env, processRunner });
  return { service, home, projectsRoot, env, calls };
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", ...args], { cwd, env, stdio: "ignore" });
}

function failure(stderr: string, exitCode = 128): GitProcessError {
  return new GitProcessError("PROCESS_FAILED", `git exited with ${exitCode}: ${stderr}`, true, exitCode, stderr);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function rejection(promise: Promise<unknown>): Promise<NodeGitServiceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NodeGitServiceError);
    return error as NodeGitServiceError;
  }
  throw new Error("expected rejection");
}

describe("Git 사용자 설정", () => {
  it("미설정이면 둘 다 null이고 저장한 뒤 다시 읽으면 같은 값이다", async () => {
    const { service } = setup();
    expect((await service.status()).identity).toEqual({ name: null, email: null });

    const saved = await service.setIdentity({ name: " 서소영 ", email: "dev@example.com" });
    expect(saved.identity).toEqual({ name: "서소영", email: "dev@example.com" });
    expect((await service.status()).identity).toEqual({ name: "서소영", email: "dev@example.com" });
  });

  it("잘못된 이름과 이메일은 field와 함께 거절하고 .gitconfig를 바꾸지 않는다", async () => {
    const { service, home } = setup();
    await service.setIdentity({ name: "ok", email: "ok@example.com" });
    const before = readFileSync(join(home, ".gitconfig"), "utf8");

    for (const input of [
      { name: "-x", email: "a@b.com", field: "name" },
      { name: "a\nb", email: "a@b.com", field: "name" },
      { name: "a", email: "a b@c.com", field: "email" },
    ]) {
      const error = await rejection(service.setIdentity({ name: input.name, email: input.email }));
      expect(error.code).toBe("invalid_request");
      expect(error.field).toBe(input.field);
    }
    expect(readFileSync(join(home, ".gitconfig"), "utf8")).toBe(before);
  });
});

describe("SSH 키", () => {
  it("만든 뒤 ready이고 공개키만 돌려주며 응답에 비밀키가 없다", async () => {
    const { service, home } = setup();
    expect((await service.status()).ssh.state).toBe("missing");

    const snapshot = await service.createSshKey();
    expect(snapshot.ssh.state).toBe("ready");
    expect(snapshot.ssh.key_path).toBe(join(home, ".ssh", "id_ed25519"));
    expect(snapshot.ssh.public_key?.startsWith("ssh-ed25519 ")).toBe(true);
    expect(snapshot.ssh.public_key).toContain("soulstream@node-a");
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE KEY");
    expect(statSync(join(home, ".ssh")).mode & 0o777).toBe(0o700);
  });

  it("이미 있으면 ssh_key_exists로 거절하고 파일은 그대로다", async () => {
    const { service, home } = setup();
    await service.createSshKey();
    const privatePath = join(home, ".ssh", "id_ed25519");
    const before = [readFileSync(privatePath), readFileSync(`${privatePath}.pub`)];

    expect((await rejection(service.createSshKey())).code).toBe("ssh_key_exists");
    expect([readFileSync(privatePath), readFileSync(`${privatePath}.pub`)]).toEqual(before);
  });

  it("비밀키만 있으면 public_missing이고 생성은 덮어쓰지 않는다", async () => {
    const { service, home } = setup();
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "SECRET-BYTES");

    const snapshot = await service.status();
    expect(snapshot.ssh).toEqual({
      state: "public_missing",
      key_path: join(home, ".ssh", "id_ed25519"),
      public_key: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain("SECRET-BYTES");
    expect((await rejection(service.createSshKey())).code).toBe("ssh_key_exists");
    expect(readFileSync(join(home, ".ssh", "id_ed25519"), "utf8")).toBe("SECRET-BYTES");
  });
});

describe("저장소 목록", () => {
  it("저장소 둘의 origin, 브랜치, 변경 여부를 읽고 일반 폴더와 파일은 건너뛴다", async () => {
    const { service, projectsRoot, env } = setup();
    const root = projectsRoot!;
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(root, name));
      git(join(root, name), env, "init", "-q", "-b", name === "alpha" ? "main" : "work");
      writeFileSync(join(root, name, "file.txt"), "one\n");
      git(join(root, name), env, "add", ".");
      git(join(root, name), env, "commit", "-q", "-m", "init");
    }
    git(join(root, "alpha"), env, "remote", "add", "origin", "git@github.com:a/alpha.git");
    writeFileSync(join(root, "beta", "file.txt"), "changed\n");
    mkdirSync(join(root, "plain-folder"));
    writeFileSync(join(root, "note.txt"), "x");

    const { projects } = await service.status();
    expect(projects.state).toBe("ready");
    expect(projects.repos).toEqual([
      { name: "alpha", origin_url: "git@github.com:a/alpha.git", branch: "main", dirty: false },
      { name: "beta", origin_url: null, branch: "work", dirty: true },
    ]);
  });

  it("root가 설정되지 않아도 identity와 ssh는 정상으로 돌려준다", async () => {
    const { service } = setup({ withProjects: false });
    await service.setIdentity({ name: "n", email: "n@example.com" });
    const snapshot = await service.status();
    expect(snapshot.projects).toEqual({ state: "root_unset", root: null, repos: [] });
    expect(snapshot.identity.name).toBe("n");
    expect(snapshot.ssh.state).toBe("missing");
  });

  it("root 폴더가 없으면 root_missing이다", async () => {
    const { home, env } = setup();
    const service = new NodeGitService({
      nodeId: "n", homeDir: home, projectsRoot: join(home, "nope"), env, processRunner: runBoundedProcess,
    });
    expect((await service.status()).projects.state).toBe("root_missing");
  });
});

describe("SSH 연결 확인", () => {
  it("종료 코드 1과 인사말이면 연결된 것이고 첫 줄을 돌려준다", async () => {
    const { service, calls } = setup({ fake: async () => ok("", "Hi x! You've successfully authenticated.\nmore", 1) });
    expect(await service.checkSsh({ host: "github.com" })).toEqual({
      host: "github.com", ok: true, reason: "connected", output: "Hi x! You've successfully authenticated.",
    });
    expect(calls[0]!.command).toBe("ssh");
    expect(calls[0]!.args).toEqual(expect.arrayContaining([
      "BatchMode=yes", "StrictHostKeyChecking=accept-new", "git@github.com",
    ]));
    expect(calls[0]!.args).not.toContain("-i");
    expect(calls[0]!.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" });
  });

  it("종료 코드 255는 사유를 가려 성공 응답 안의 ok:false로 돌려준다", async () => {
    const cases: Array<[string, string]> = [
      ["git@github.com: Permission denied (publickey).", "auth_failed"],
      ["ssh: Could not resolve hostname nope", "unreachable"],
      ["Host key verification failed.", "host_key_mismatch"],
      ["something else", "failed"],
    ];
    for (const [stderr, reason] of cases) {
      const { service } = setup({ fake: async () => ok("", stderr, 255) });
      const result = await service.checkSsh({ host: "github.com" });
      expect(result).toMatchObject({ ok: false, reason, output: stderr });
    }
  });
});

describe("클론", () => {
  const url = "git@github.com:a/b.git";

  it("git clone을 열린 인자로 시작하고 running에서 done으로 바뀐다", async () => {
    const gate = deferred<BoundedProcessResult>();
    const { service, calls } = setup({ fake: () => gate.promise });

    const job = await service.startClone({ url });
    expect(job).toMatchObject({ repo_name: "b", url, state: "running", error: null, finished_at: null });
    const target = join((await service.status()).projects.root!, "b");
    expect(calls[0]!.command).toBe("git");
    expect(calls[0]!.args).toEqual(["clone", "--", url, target]);
    expect(calls[0]!.cwd).toBe((await service.status()).projects.root);
    expect(calls[0]!.env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    });
    expect(service.cloneStatus({ clone_id: job.clone_id }).state).toBe("running");
    expect((await service.status()).clone?.clone_id).toBe(job.clone_id);

    gate.resolve(ok());
    await vi.waitFor(() => expect(service.cloneStatus({ clone_id: job.clone_id }).state).toBe("done"));
    expect(service.cloneStatus({ clone_id: job.clone_id }).finished_at).not.toBeNull();
  });

  it("같은 이름이 있으면 repo_exists, 실행 중이면 clone_busy로 거절한다", async () => {
    const gate = deferred<BoundedProcessResult>();
    const { service, projectsRoot } = setup({ fake: () => gate.promise });
    mkdirSync(join(projectsRoot!, "taken"));

    expect((await rejection(service.startClone({ url: "git@github.com:a/taken.git" }))).code).toBe("repo_exists");
    await service.startClone({ url });
    expect((await rejection(service.startClone({ url: "git@github.com:a/other.git" }))).code).toBe("clone_busy");
    gate.resolve(ok());
  });

  it("인증 실패는 failed와 auth_failed로 남기고 남은 대상 폴더를 지운다", async () => {
    const { service, projectsRoot } = setup({
      fake: async (input) => {
        mkdirSync(input.args[3]!);
        throw failure("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.");
      },
    });
    const job = await service.startClone({ url });
    await vi.waitFor(() => expect(service.cloneStatus({ clone_id: job.clone_id }).state).toBe("failed"));
    const failed = service.cloneStatus({ clone_id: job.clone_id });
    expect(failed.error?.code).toBe("auth_failed");
    expect(failed.error?.detail).toContain("Permission denied (publickey)");
    expect(existsSync(join(projectsRoot!, "b"))).toBe(false);
  });

  it("projects root가 없으면 projects_root_unavailable이고 모르는 clone_id는 clone_not_found다", async () => {
    const { service } = setup({ withProjects: false });
    expect((await rejection(service.startClone({ url }))).code).toBe("projects_root_unavailable");
    expect(() => service.cloneStatus({ clone_id: "missing" })).toThrowError(
      expect.objectContaining({ code: "clone_not_found" }),
    );
  });

  it("repo_name이 따로 오면 그 이름으로 받고 규칙에 맞지 않으면 field와 함께 거절한다", async () => {
    const { service, calls } = setup({ fake: async () => ok() });
    const job = await service.startClone({ url, repo_name: "mine" });
    expect(job.repo_name).toBe("mine");
    expect(calls[0]!.args[3]).toMatch(/mine$/);
    const error = await rejection(service.startClone({ url, repo_name: "a--b" }));
    expect(error).toMatchObject({ code: "invalid_request", field: "repo_name" });
  });
});

describe("입력 검증 표", () => {
  it("허용하는 URL 세 형태", () => {
    for (const url of [
      "https://github.com/a/b.git",
      "git@github.com:a/b.git",
      "ssh://git@host.example:2222/a/b",
      "ssh://host.example/a/b",
    ]) {
      expect(parseCloneUrl(url)).toBe(url);
    }
  });

  it("거절하는 URL", () => {
    for (const url of [
      "--upload-pack=x",
      "ext::sh -c x",
      "file:///etc",
      "/abs/path",
      "https://tok@github.com/a/b",
      "git@-oProxyCommand=x:a/b",
      "https://github.com/a b",
      "https://github.com/a\nb",
      "https://github.com:70000/a/b",
      "git@github.com:/abs",
      `https://github.com/${"a".repeat(2048)}`,
    ]) {
      expect(() => parseCloneUrl(url), url).toThrowError(expect.objectContaining({ code: "invalid_request", field: "url" }));
    }
  });

  it("repo_name 거절과 URL에서의 이름 유도", () => {
    for (const name of ["..", "a/b", "-x", "a--b", ".h", "x.git", "a".repeat(101)]) {
      expect(() => parseRepoName(name), name).toThrowError(expect.objectContaining({ field: "repo_name" }));
    }
    expect(parseRepoName("repo.v2")).toBe("repo.v2");
    expect(deriveRepoName("git@github.com:a/b.git")).toBe("b");
    expect(deriveRepoName("https://github.com/a/b/")).toBe("b");
    expect(deriveRepoName("ssh://git@h.example:22/a/c.git")).toBe("c");
    expect(() => deriveRepoName("https://github.com/a/x--y.git")).toThrowError(
      expect.objectContaining({ field: "repo_name" }),
    );
  });

  it("host 거절", () => {
    for (const host of ["-oProxyCommand=x", "git@github.com", "", "a b", "a".repeat(254)]) {
      expect(() => parseHost(host), host).toThrowError(expect.objectContaining({ field: "host" }));
    }
    expect(parseHost("github.com")).toBe("github.com");
  });

  it("이메일 경계", () => {
    expect(parseIdentity({ name: "a", email: "a@b.co" }).email).toBe("a@b.co");
    for (const email of ["a b@c.com", "-a@c.com", "a@", "@c.com", "a@@c.com", `${"a".repeat(250)}@b.co`, 3]) {
      expect(() => parseIdentity({ name: "a", email }), String(email)).toThrowError(
        expect.objectContaining({ field: "email" }),
      );
    }
  });
});
