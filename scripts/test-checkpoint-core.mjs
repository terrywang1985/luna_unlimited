import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { createLunaCore } from "../src/core/runtime.mjs";
import { CoreErrorCode } from "../src/core/errors.mjs";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "luna-checkpoint-core-"));
const workspaceRoot = path.join(temporaryRoot, "workspace");
const logsDir = path.join(workspaceRoot, "logs");
const checkpointRoot = path.join(temporaryRoot, "private-checkpoints");
const context = {
  caller: { clientId: "checkpoint-test", clientName: "direct-core", sessionId: "checkpoint-session", protocol: "direct" },
  workSessionId: "checkpoint-work"
};

async function exists(targetPath) {
  return access(targetPath).then(() => true).catch(() => false);
}

async function write(core, filePath, content) {
  const result = await core.execute("write_text_file", { path: filePath, content }, context);
  if (!result.ok) throw new Error(`Failed to write ${filePath}: ${result.error.message}`);
}

try {
  const core = await createLunaCore({
    workspaceRoot,
    logsDir,
    checkpointRoot,
    maxFileBytes: 1024 * 1024,
    maxCommandOutputBytes: 256 * 1024,
    maxCheckpointFiles: 100,
    maxCheckpointBytes: 4 * 1024 * 1024,
    maxCheckpoints: 10
  });

  await write(core, "src/a.txt", "checkpoint-a\n");
  await write(core, "src/b.txt", "checkpoint-b\n");
  await writeFile(path.join(workspaceRoot, ".env"), "SECRET=before\n", "utf8");
  await mkdir(path.join(workspaceRoot, "node_modules", "fixture"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "node_modules", "fixture", "cache.bin"), "dependency-before", "utf8");

  const created = await core.execute("create_checkpoint", { label: "before refactor" }, context);
  if (!created.ok || created.data.structured.backend !== "local-snapshot") {
    throw new Error("create_checkpoint did not create a local snapshot");
  }
  const checkpoint = created.data.structured;
  if (!/^cp_\d{8}T\d{6}Z_[a-f0-9]{8}$/.test(checkpoint.id)) throw new Error("Checkpoint ID format is unstable");
  if (JSON.stringify(checkpoint).includes(temporaryRoot)) throw new Error("Checkpoint result leaked a private absolute path");
  if (checkpoint.excluded.sensitive < 1 || checkpoint.excluded.dependencies < 1 || checkpoint.excluded.runtime < 1) {
    throw new Error("Checkpoint did not report sensitive/dependency/runtime exclusions");
  }

  const listed = await core.execute("list_checkpoints", {}, context);
  if (!listed.ok || !listed.data.structured.checkpoints.some((entry) => entry.id === checkpoint.id)) {
    throw new Error("list_checkpoints did not return the created checkpoint");
  }

  await write(core, "src/a.txt", "changed-a\n");
  await write(core, "src/b.txt", "changed-b\n");
  await write(core, "src/new.txt", "created-after-checkpoint\n");
  await writeFile(path.join(workspaceRoot, ".env"), "SECRET=after\n", "utf8");
  await writeFile(path.join(workspaceRoot, "node_modules", "fixture", "cache.bin"), "dependency-after", "utf8");

  const restored = await core.execute("restore_checkpoint", { checkpointId: checkpoint.id }, context);
  if (!restored.ok || restored.data.structured.rolledBack !== false) {
    throw new Error(`restore_checkpoint failed: ${restored.error?.message || "unknown"}`);
  }
  if (await readFile(path.join(workspaceRoot, "src", "a.txt"), "utf8") !== "checkpoint-a\n") {
    throw new Error("restore_checkpoint did not restore modified content");
  }
  if (await readFile(path.join(workspaceRoot, "src", "b.txt"), "utf8") !== "checkpoint-b\n") {
    throw new Error("restore_checkpoint did not restore the second file");
  }
  if (await exists(path.join(workspaceRoot, "src", "new.txt"))) {
    throw new Error("restore_checkpoint did not remove a post-checkpoint file");
  }
  if (await readFile(path.join(workspaceRoot, ".env"), "utf8") !== "SECRET=after\n") {
    throw new Error("restore_checkpoint touched an excluded sensitive file");
  }
  if (await readFile(path.join(workspaceRoot, "node_modules", "fixture", "cache.bin"), "utf8") !== "dependency-after") {
    throw new Error("restore_checkpoint touched excluded dependencies");
  }

  const deleted = await core.execute("delete_checkpoint", { checkpointId: checkpoint.id }, context);
  if (!deleted.ok || deleted.data.structured.deleted !== true) throw new Error("delete_checkpoint failed");

  const rollbackCheckpoint = await core.execute("create_checkpoint", { label: "rollback probe" }, context);
  const rollbackId = rollbackCheckpoint.data.structured.id;
  await write(core, "src/a.txt", "pre-restore-a\n");
  await write(core, "src/b.txt", "pre-restore-b\n");
  const applyState = core.checkpoints.applyState.bind(core.checkpoints);
  let injectFailure = true;
  core.checkpoints.applyState = async (target, current) => {
    if (injectFailure) {
      injectFailure = false;
      await writeFile(path.join(workspaceRoot, "src", "a.txt"), target.files.get("src/a.txt").content);
      throw new Error("injected restore failure");
    }
    return applyState(target, current);
  };
  const failedRestore = await core.execute("restore_checkpoint", { checkpointId: rollbackId }, context);
  core.checkpoints.applyState = applyState;
  if (failedRestore.ok || failedRestore.error.details.rolledBack !== true) {
    throw new Error("Failed restore did not report a completed rollback");
  }
  if (await readFile(path.join(workspaceRoot, "src", "a.txt"), "utf8") !== "pre-restore-a\n") {
    throw new Error("Restore rollback did not recover the first pre-restore file");
  }
  if (await readFile(path.join(workspaceRoot, "src", "b.txt"), "utf8") !== "pre-restore-b\n") {
    throw new Error("Restore rollback did not recover the second pre-restore file");
  }
  const rollbackAudit = core.audit.list(20).find(
    (event) => event.tool === "restore_checkpoint" && event.path === rollbackId && event.status === "error"
  );
  if (rollbackAudit?.details?.rolledBack !== true) throw new Error("Restore rollback was not visible in audit details");
  await core.execute("delete_checkpoint", { checkpointId: rollbackId }, context);

  const corruptCheckpoint = await core.execute("create_checkpoint", { label: "integrity probe" }, context);
  const corruptId = corruptCheckpoint.data.structured.id;
  await writeFile(path.join(core.checkpoints.root, corruptId, "files", "src", "a.txt"), "corrupted", "utf8");
  const beforeCorruptRestore = await readFile(path.join(workspaceRoot, "src", "a.txt"), "utf8");
  const corruptRestore = await core.execute("restore_checkpoint", { checkpointId: corruptId }, context);
  if (corruptRestore.ok || corruptRestore.error.code !== CoreErrorCode.CHECKPOINT_INVALID) {
    throw new Error("Corrupted checkpoint was not rejected before restore");
  }
  if (await readFile(path.join(workspaceRoot, "src", "a.txt"), "utf8") !== beforeCorruptRestore) {
    throw new Error("Corrupted checkpoint changed workspace content");
  }
  await core.execute("delete_checkpoint", { checkpointId: corruptId }, context);

  const missing = await core.execute(
    "restore_checkpoint",
    { checkpointId: "cp_20000101T000000Z_00000000" },
    context
  );
  if (missing.ok || missing.error.code !== CoreErrorCode.CHECKPOINT_NOT_FOUND) {
    throw new Error("Missing checkpoint did not return CHECKPOINT_NOT_FOUND");
  }

  if (!core.policy.protectedTools.has("restore_checkpoint") || !core.policy.protectedTools.has("delete_checkpoint")) {
    throw new Error("Destructive checkpoint operations are not approval protected");
  }
  const finalList = await core.execute("list_checkpoints", {}, context);
  if (!finalList.ok || finalList.data.structured.total !== 0) throw new Error("Checkpoint cleanup did not finish");

  let insideWorkspaceRejected = false;
  try {
    await createLunaCore({
      workspaceRoot: path.join(temporaryRoot, "unsafe-workspace"),
      logsDir: path.join(temporaryRoot, "unsafe-logs"),
      checkpointRoot: path.join(temporaryRoot, "unsafe-workspace", ".checkpoints"),
      maxFileBytes: 1024,
      maxCommandOutputBytes: 4096
    });
  } catch (error) {
    insideWorkspaceRejected = error?.code === CoreErrorCode.INVALID_ARGUMENT;
  }
  if (!insideWorkspaceRejected) throw new Error("Checkpoint storage inside workspace was not rejected");

  console.log("PASS: non-Git local checkpoints restore modified and deleted files");
  console.log("PASS: post-checkpoint files are removed while secrets and node_modules are preserved");
  console.log("PASS: failed restore rolls back and records rolledBack=true in audit");
  console.log("PASS: corrupted, missing, and in-workspace checkpoint storage are rejected safely");
  console.log("PASS: checkpoint metadata never exposes private absolute storage paths");
  await core.audit.flush();
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
