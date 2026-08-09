import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

import { createLunaCore } from "../src/core/runtime.mjs";
import { CoreErrorCode } from "../src/core/errors.mjs";
import { createSafeCommandEnvironment } from "../src/core/process.mjs";

async function collectModules(directory) {
  const modules = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) modules.push(...await collectModules(target));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) modules.push(target);
  }
  return modules;
}

const projectRoot = path.resolve(import.meta.dirname, "..");
const coreModules = await collectModules(path.join(projectRoot, "src", "core"));
for (const modulePath of coreModules) {
  const source = await readFile(modulePath, "utf8");
  if (source.includes("@modelcontextprotocol/sdk") || /from\s+["']zod["']/.test(source)) {
    throw new Error(`Core protocol boundary violated by ${path.relative(projectRoot, modulePath)}`);
  }
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "luna-core-architecture-"));
const workspaceRoot = path.join(temporaryRoot, "workspace");
const logsDir = path.join(temporaryRoot, "logs");

try {
  const core = await createLunaCore({
    workspaceRoot,
    logsDir,
    maxFileBytes: 1024 * 1024,
    maxCommandOutputBytes: 256 * 1024
  });
  const context = {
    caller: { clientId: "architecture-test", clientName: "test-host", sessionId: "session-1", protocol: "direct" },
    workSessionId: "work-1"
  };

  const write = await core.execute("write_text_file", { path: "round-trip.txt", content: "core-ok" }, context);
  if (!write.ok || write.data.text !== "Wrote 7 bytes to round-trip.txt") {
    throw new Error("Direct Core write result contract failed");
  }

  const read = await core.execute("read_text_file", { path: "round-trip.txt" }, context);
  if (!read.ok || read.data.text !== "core-ok" || read.data.structured?.text !== "core-ok") {
    throw new Error("Direct Core read result contract failed");
  }

  const stat = await core.execute("stat_path", { path: "round-trip.txt" }, context);
  const expectedSha256 = stat.data.structured.sha256;
  if (!stat.ok || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("stat_path did not return a stable content hash");
  }

  const batch = await core.execute("write_files", {
    files: [
      { path: "round-trip.txt", content: "core-updated", expectedSha256 },
      { path: "nested/new.txt", content: "new-file" }
    ]
  }, context);
  if (!batch.ok || batch.data.structured.files.length !== 2 || batch.data.details.committed !== true) {
    throw new Error("Atomic write_files direct Core contract failed");
  }

  const stale = await core.execute("write_files", {
    files: [{ path: "round-trip.txt", content: "stale-write", expectedSha256 }]
  }, context);
  if (stale.ok || stale.error.code !== CoreErrorCode.FILE_CHANGED) {
    throw new Error("Stale hash was not rejected as FILE_CHANGED");
  }

  const unchanged = await readFile(path.join(workspaceRoot, "round-trip.txt"), "utf8");
  if (unchanged !== "core-updated") throw new Error("Stale write changed the file");

  const order = [];
  await Promise.all([
    core.mutations.run(path.join(workspaceRoot, "queue.txt"), async () => {
      order.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 25));
      await writeFile(path.join(workspaceRoot, "queue.txt"), "first", "utf8");
      order.push("first-end");
    }),
    core.mutations.run(path.join(workspaceRoot, "queue.txt"), async () => {
      order.push("second-start");
      await writeFile(path.join(workspaceRoot, "queue.txt"), "second", "utf8");
      order.push("second-end");
    })
  ]);
  if (order.join(",") !== "first-start,first-end,second-start,second-end") {
    throw new Error(`Per-file mutation queue did not serialize writes: ${order.join(",")}`);
  }

  const traversal = await core.execute("read_text_file", { path: "../outside.txt" }, context);
  if (traversal.ok || traversal.error.code !== CoreErrorCode.PATH_OUTSIDE_WORKSPACE) {
    throw new Error("Core traversal error is not structured as PATH_OUTSIDE_WORKSPACE");
  }

  execFileSync("git", ["init", "--quiet", temporaryRoot], { windowsHide: true });
  await writeFile(path.join(temporaryRoot, ".gitignore"), "workspace/\n", "utf8");
  const parentIgnoreSearch = await core.execute(
    "search_files",
    { query: "round-trip", path: ".", searchType: "filename", maxResults: 20 },
    context
  );
  if (!parentIgnoreSearch.ok || !parentIgnoreSearch.data.text.includes("round-trip.txt")) {
    throw new Error("File search inherited ignore rules from above the authorized workspace");
  }
  const parentGit = await core.execute(
    "exec_command",
    { program: "git", args: ["status", "--short"], cwd: ".", timeoutSeconds: 15 },
    context
  );
  if (!parentGit.ok || parentGit.data.details.exitCode === 0) {
    throw new Error("Git discovered a repository above the authorized workspace");
  }

  const parentNpmMarker = path.join(temporaryRoot, "parent-npm-script-ran.txt");
  await writeFile(path.join(temporaryRoot, "package.json"), `${JSON.stringify({
    name: "outside-parent-project",
    private: true,
    scripts: {
      test: `node -e "require('node:fs').writeFileSync(${JSON.stringify(parentNpmMarker)},'unsafe')"`
    }
  }, null, 2)}\n`, "utf8");
  const parentNpm = await core.execute(
    "exec_command",
    { program: "npm", args: ["test"], cwd: ".", timeoutSeconds: 15 },
    context
  );
  if (parentNpm.ok || parentNpm.error.code !== CoreErrorCode.COMMAND_NOT_ALLOWED) {
    throw new Error("npm was not blocked from discovering a parent package.json");
  }
  if (await access(parentNpmMarker).then(() => true).catch(() => false)) {
    throw new Error("npm executed a project script outside the authorized workspace");
  }

  await writeFile(path.join(temporaryRoot, "go.mod"), "module outside.example/parent\n\ngo 1.20\n", "utf8");
  const parentGo = await core.execute(
    "exec_command",
    { program: "go", args: ["test", "./..."], cwd: ".", timeoutSeconds: 15 },
    context
  );
  if (parentGo.ok || parentGo.error.code !== CoreErrorCode.COMMAND_NOT_ALLOWED) {
    throw new Error("Go was not blocked from discovering a parent go.mod/go.work");
  }

  execFileSync("git", ["init", "--quiet", workspaceRoot], { windowsHide: true });
  const workspaceGit = await core.execute(
    "exec_command",
    { program: "git", args: ["status", "--short"], cwd: ".", timeoutSeconds: 15 },
    context
  );
  if (!workspaceGit.ok || workspaceGit.data.details.exitCode !== 0) {
    throw new Error("Git repository inside the authorized workspace stopped working");
  }

  await writeFile(path.join(workspaceRoot, "package.json"), `${JSON.stringify({
    name: "inside-workspace-project",
    private: true,
    scripts: { test: "node -e \"console.log('workspace npm ok')\"" }
  }, null, 2)}\n`, "utf8");
  const workspaceNpm = await core.execute(
    "exec_command",
    { program: "npm", args: ["test"], cwd: ".", timeoutSeconds: 15 },
    context
  );
  if (!workspaceNpm.ok || workspaceNpm.data.details.exitCode !== 0 || !workspaceNpm.data.text.includes("workspace npm ok")) {
    throw new Error("npm project inside the authorized workspace stopped working");
  }

  const safeEnvironment = createSafeCommandEnvironment({
    PATH: process.env.PATH,
    GIT_DIR: "../outside.git",
    GIT_WORK_TREE: "../outside-tree",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "malicious-command",
    NODE_OPTIONS: "--require=../outside.js",
    NPM_CONFIG_SCRIPT_SHELL: "../outside-shell.exe",
    GOWORK: "../go.work",
    GOFLAGS: "-toolexec=../outside.exe"
  });
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "NODE_OPTIONS",
    "NPM_CONFIG_SCRIPT_SHELL",
    "GOWORK",
    "GOFLAGS"
  ]) {
    if (Object.hasOwn(safeEnvironment, name)) throw new Error(`Unsafe command environment variable survived: ${name}`);
  }

  core.setToolPermission("write_text_file", false);
  const disabled = await core.execute("write_text_file", { path: "denied.txt", content: "denied" }, context);
  if (disabled.ok || disabled.error.code !== CoreErrorCode.TOOL_DISABLED) {
    throw new Error("Core permission error is not structured as TOOL_DISABLED");
  }

  const readAudit = core.audit.list(20).find((event) => event.tool === "read_text_file" && event.status === "success");
  if (readAudit?.details?.context?.clientId !== "architecture-test" || readAudit.details.context.workSessionId !== "work-1") {
    throw new Error("CallerContext / WorkSessionContext was not retained for audit");
  }

  console.log("PASS: Core modules do not depend on MCP SDK or Zod");
  console.log("PASS: direct Core file operations return protocol-neutral DTOs");
  console.log("PASS: Core errors expose stable structured error codes");
  console.log("PASS: caller and work-session metadata are audit-only context");
  console.log("PASS: content hashes reject stale edits and multi-file writes commit atomically");
  console.log("PASS: per-file mutation queues serialize concurrent writers");
  console.log("PASS: file search ignores repository rules above the authorized workspace");
  console.log("PASS: Git, npm, and Go cannot discover projects above the authorized workspace");
  console.log("PASS: workspace-local Git and npm projects remain executable");
  console.log("PASS: inherited Git, Node/npm, and Go execution-control variables are filtered");
  await core.audit.flush();
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
