import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

import { CoreErrorCode } from "../src/core/errors.mjs";
import { FileMutationQueue } from "../src/core/mutation-queue.mjs";
import {
  RepositoryService,
  resolvePublicGitHubRepositoryUrl
} from "../src/core/repositories.mjs";
import { createLunaCore } from "../src/core/runtime.mjs";
import { WorkspaceService } from "../src/core/workspace.mjs";

const publicDns = async () => [{ address: "140.82.112.3", family: 4 }];

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (error) => error?.code === code);
}

function successfulRunnerFixture({ sensitive = false, oversized = false, failClone = false } = {}) {
  const calls = [];
  const runner = async (executable, args, options) => {
    calls.push({ executable, args, options });
    if (args.includes("clone")) {
      const destinationName = args.at(-1);
      const cloneRoot = path.join(options.cwd, destinationName);
      await mkdir(path.join(cloneRoot, ".git"), { recursive: true });
      await writeFile(path.join(cloneRoot, "README.md"), oversized ? "x".repeat(1024) : "public fixture\n", "utf8");
      if (sensitive) await writeFile(path.join(cloneRoot, ".env"), "SECRET=blocked\n", "utf8");
      return {
        exitCode: failClone ? 128 : 0,
        stdout: "",
        stderr: failClone ? "repository not found" : "",
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false
      };
    }
    return {
      exitCode: 0,
      stdout: "0123456789abcdef0123456789abcdef01234567\n",
      stderr: "",
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false
    };
  };
  return { runner, calls };
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "luna-repository-core-"));
const workspaceRoot = path.join(temporaryRoot, "workspace");
await mkdir(workspaceRoot, { recursive: true });

try {
  const canonical = await resolvePublicGitHubRepositoryUrl(
    "https://github.com/terrywang1985/luna_unlimited",
    publicDns
  );
  assert.equal(canonical.url, "https://github.com/terrywang1985/luna_unlimited.git");
  assert.equal(canonical.repositoryPath, "terrywang1985/luna_unlimited");

  for (const url of [
    "http://github.com/owner/repo",
    "https://token@github.com/owner/repo",
    "https://github.com:8443/owner/repo",
    "https://gitlab.com/owner/repo",
    "https://github.com/owner/repo?token=secret",
    "file:///tmp/repo"
  ]) {
    await rejectsCode(
      () => resolvePublicGitHubRepositoryUrl(url, publicDns),
      CoreErrorCode.REPOSITORY_SOURCE_NOT_ALLOWED
    );
  }
  await rejectsCode(
    () => resolvePublicGitHubRepositoryUrl(
      "https://github.com/owner/repo",
      async () => [{ address: "127.0.0.1", family: 4 }]
    ),
    CoreErrorCode.REPOSITORY_SOURCE_NOT_ALLOWED
  );

  const workspace = new WorkspaceService(workspaceRoot);
  const mutations = new FileMutationQueue();
  const fixture = successfulRunnerFixture();
  const service = new RepositoryService({
    workspace,
    mutations,
    maxRepositoryFiles: 100,
    maxRepositoryBytes: 4096,
    processRunner: fixture.runner,
    repositoryUrlResolver: async () => canonical
  });
  const cloned = await service.clone({
    url: canonical.url,
    destination: "cloned-project",
    ref: "main",
    depth: 1,
    timeoutSeconds: 30
  });
  assert.equal(cloned.structured.destination, "cloned-project");
  assert.equal(cloned.structured.commit, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(await readFile(path.join(workspaceRoot, "cloned-project", "README.md"), "utf8"), "public fixture\n");
  const cloneCall = fixture.calls.find((call) => call.args.includes("clone"));
  assert.equal(cloneCall.executable, "git");
  assert.ok(cloneCall.args.includes("--single-branch"));
  assert.ok(cloneCall.args.includes("--no-tags"));
  assert.equal(cloneCall.options.environmentOverrides.GIT_ALLOW_PROTOCOL, "https");
  assert.equal(cloneCall.options.environmentOverrides.GIT_TERMINAL_PROMPT, "0");
  assert.equal(cloneCall.options.environmentOverrides.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(cloneCall.options.environmentOverrides.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : os.devNull);
  assert.equal(cloneCall.options.environmentOverrides.GIT_LFS_SKIP_SMUDGE, "1");

  await rejectsCode(
    () => service.clone({ url: canonical.url, destination: "cloned-project", depth: 1, timeoutSeconds: 30 }),
    CoreErrorCode.FILE_ALREADY_EXISTS
  );
  await rejectsCode(
    () => service.clone({ url: canonical.url, destination: "../escape", depth: 1, timeoutSeconds: 30 }),
    CoreErrorCode.PATH_OUTSIDE_WORKSPACE
  );
  await rejectsCode(
    () => service.clone({ url: canonical.url, destination: "bad-ref", ref: "../../main", depth: 1, timeoutSeconds: 30 }),
    CoreErrorCode.INVALID_ARGUMENT
  );

  const failureFixture = successfulRunnerFixture({ failClone: true });
  const failureService = new RepositoryService({
    workspace,
    mutations,
    maxRepositoryFiles: 100,
    maxRepositoryBytes: 4096,
    processRunner: failureFixture.runner,
    repositoryUrlResolver: async () => canonical
  });
  await rejectsCode(
    () => failureService.clone({ url: canonical.url, destination: "failed-project", depth: 1, timeoutSeconds: 30 }),
    CoreErrorCode.REPOSITORY_CLONE_FAILED
  );
  assert.equal(await access(path.join(workspaceRoot, "failed-project")).then(() => true).catch(() => false), false);
  assert.equal((await readdir(workspaceRoot)).some((name) => name.startsWith(".luna-clone-")), false);

  const sensitiveFixture = successfulRunnerFixture({ sensitive: true });
  const sensitiveService = new RepositoryService({
    workspace,
    mutations,
    maxRepositoryFiles: 100,
    maxRepositoryBytes: 4096,
    processRunner: sensitiveFixture.runner,
    repositoryUrlResolver: async () => canonical
  });
  await rejectsCode(
    () => sensitiveService.clone({ url: canonical.url, destination: "sensitive-project", depth: 1, timeoutSeconds: 30 }),
    CoreErrorCode.SENSITIVE_PATH
  );
  assert.equal(await access(path.join(workspaceRoot, "sensitive-project")).then(() => true).catch(() => false), false);

  const oversizedFixture = successfulRunnerFixture({ oversized: true });
  const oversizedService = new RepositoryService({
    workspace,
    mutations,
    maxRepositoryFiles: 100,
    maxRepositoryBytes: 100,
    processRunner: oversizedFixture.runner,
    repositoryUrlResolver: async () => canonical
  });
  await rejectsCode(
    () => oversizedService.clone({ url: canonical.url, destination: "oversized-project", depth: 1, timeoutSeconds: 30 }),
    CoreErrorCode.REPOSITORY_LIMIT_EXCEEDED
  );

  const core = await createLunaCore({
    workspaceRoot,
    logsDir: path.join(temporaryRoot, "logs"),
    checkpointRoot: path.join(temporaryRoot, "checkpoints"),
    maxFileBytes: 1024 * 1024,
    maxCommandOutputBytes: 64 * 1024
  });
  const auditedFixture = successfulRunnerFixture();
  core.repositories = new RepositoryService({
    workspace: core.workspace,
    mutations: core.mutations,
    maxRepositoryFiles: 100,
    maxRepositoryBytes: 4096,
    processRunner: auditedFixture.runner,
    repositoryUrlResolver: async () => canonical
  });
  core.actionHandlers["git.clone"] = (request) => core.repositories.clone(request);
  const result = await core.execute("git.clone", {
    url: canonical.url,
    destination: "audited-project",
    ref: null,
    depth: 1,
    timeoutSeconds: 30
  }, { caller: { clientId: "repository-test", protocol: "direct" } });
  assert.equal(result.ok, true);
  const audit = core.audit.list(20).find((event) => event.tool === "git.clone" && event.status === "success");
  assert.equal(audit.details.repositoryHost, "github.com");
  assert.equal(audit.details.repositoryPath, "terrywang1985/luna_unlimited");
  assert.equal(JSON.stringify(audit).includes("token="), false);

  core.setActionPermission("git.clone", false);
  const denied = await core.execute("git.clone", {
    url: canonical.url,
    destination: "denied-project",
    depth: 1,
    timeoutSeconds: 30
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, CoreErrorCode.TOOL_DISABLED);
  await core.audit.flush();

  console.log("PASS: public GitHub URL validation blocks credentials, alternate protocols, ports, hosts, and private DNS");
  console.log("PASS: clone_repository uses non-interactive restricted Git settings and verifies HEAD");
  console.log("PASS: clone_repository commits a validated repository into a new workspace destination");
  console.log("PASS: traversal, unsafe refs, sensitive paths, size limits, and existing destinations are rejected");
  console.log("PASS: failed clone attempts leave no destination or private temporary directory behind");
  console.log("PASS: clone_repository permission and redacted audit behavior are enforced by Core");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
