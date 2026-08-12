import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { createPinnedLookup, resolvePublicArtifactUrl } from "../src/core/artifacts.mjs";
import { createLunaCore } from "../src/core/runtime.mjs";
import { sha256 } from "../src/core/hash.mjs";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "luna-artifact-core-"));
const workspaceRoot = path.join(temporaryRoot, "workspace");
const logsDir = path.join(temporaryRoot, "logs");
const checkpointRoot = path.join(temporaryRoot, "checkpoints");
const context = {
  caller: { clientId: "artifact-test", clientName: "direct-core", sessionId: "artifact-session", protocol: "direct" },
  workSessionId: "artifact-work"
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function exists(relativePath) {
  return access(path.join(workspaceRoot, relativePath)).then(() => true).catch(() => false);
}

await mkdir(workspaceRoot, { recursive: true });
const core = await createLunaCore({
  workspaceRoot,
  logsDir,
  checkpointRoot,
  maxFileBytes: 1024 * 1024,
  maxBatchBytes: 8 * 1024 * 1024,
  maxCommandOutputBytes: 256 * 1024,
  maxArtifactBytes: 1024 * 1024,
  maxOperationEntries: 100
});

try {
  const pinnedLookup = createPinnedLookup({ address: "93.184.216.34", family: 4 });
  const legacyLookup = await new Promise((resolve, reject) => pinnedLookup("example.test", {}, (error, address, family) => {
    if (error) reject(error);
    else resolve({ address, family });
  }));
  assert.deepEqual(legacyLookup, { address: "93.184.216.34", family: 4 });
  const allLookup = await new Promise((resolve, reject) => pinnedLookup("example.test", { all: true }, (error, addresses) => {
    if (error) reject(error);
    else resolve(addresses);
  }));
  assert.deepEqual(allLookup, [{ address: "93.184.216.34", family: 4 }]);

  const created = await core.execute("workspace.mkdir", { path: "ops/nested" }, context);
  const idempotent = await core.execute("workspace.mkdir", { path: "ops/nested" }, context);
  assert.equal(created.ok, true);
  assert.equal(created.data.structured.created, true);
  assert.equal(idempotent.data.structured.created, false);

  await writeFile(path.join(workspaceRoot, "ops", "move-source.txt"), "move-source\n", "utf8");
  const sourceHash = sha256("move-source\n");
  const moved = await core.execute("workspace.move", {
    source: "ops/move-source.txt",
    destination: "ops/moved.txt",
    expectedSha256: sourceHash
  }, context);
  assert.equal(moved.ok, true, moved.error?.message);
  assert.equal(await exists("ops/move-source.txt"), false);
  assert.equal(await readFile(path.join(workspaceRoot, "ops", "moved.txt"), "utf8"), "move-source\n");

  await writeFile(path.join(workspaceRoot, "ops", "overwrite-source.txt"), "new\n", "utf8");
  await writeFile(path.join(workspaceRoot, "ops", "overwrite-destination.txt"), "old\n", "utf8");
  const overwritten = await core.execute("workspace.move", {
    source: "ops/overwrite-source.txt",
    destination: "ops/overwrite-destination.txt",
    overwrite: true,
    expectedSha256: sha256("new\n"),
    expectedDestinationSha256: sha256("old\n")
  }, context);
  assert.equal(overwritten.ok, true, overwritten.error?.message);
  assert.equal(await readFile(path.join(workspaceRoot, "ops", "overwrite-destination.txt"), "utf8"), "new\n");

  await writeFile(path.join(workspaceRoot, "ops", "rollback-source.txt"), "source\n", "utf8");
  await writeFile(path.join(workspaceRoot, "ops", "rollback-destination.txt"), "destination\n", "utf8");
  const originalRename = core.fileOperations.renamePath.bind(core.fileOperations);
  let renameCalls = 0;
  core.fileOperations.renamePath = async (...args) => {
    renameCalls += 1;
    if (renameCalls === 2) throw new Error("injected move failure");
    return originalRename(...args);
  };
  const failedMove = await core.execute("workspace.move", {
    source: "ops/rollback-source.txt",
    destination: "ops/rollback-destination.txt",
    overwrite: true,
    expectedSha256: sha256("source\n"),
    expectedDestinationSha256: sha256("destination\n")
  }, context);
  core.fileOperations.renamePath = originalRename;
  assert.equal(failedMove.ok, false);
  assert.equal(failedMove.error.details.rolledBack, true);
  assert.equal(await readFile(path.join(workspaceRoot, "ops", "rollback-source.txt"), "utf8"), "source\n");
  assert.equal(await readFile(path.join(workspaceRoot, "ops", "rollback-destination.txt"), "utf8"), "destination\n");

  await mkdir(path.join(workspaceRoot, "ops", "concurrent-tree"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "ops", "concurrent-tree", "child.txt"), "child\n", "utf8");
  let releaseChildMutation;
  let signalChildMutation;
  const childMutationEntered = new Promise((resolve) => { signalChildMutation = resolve; });
  const childMutationRelease = new Promise((resolve) => { releaseChildMutation = resolve; });
  const childMutation = core.mutations.run(
    path.join(workspaceRoot, "ops", "concurrent-tree", "child.txt"),
    async () => {
      signalChildMutation();
      await childMutationRelease;
    }
  );
  await childMutationEntered;
  let directoryMoveFinished = false;
  const directoryMove = core.execute("workspace.move", {
    source: "ops/concurrent-tree",
    destination: "ops/concurrent-tree-moved"
  }, context).then((result) => {
    directoryMoveFinished = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(directoryMoveFinished, false, "directory move must wait for descendant mutations");
  releaseChildMutation();
  await childMutation;
  const directoryMoveResult = await directoryMove;
  assert.equal(directoryMoveResult.ok, true, directoryMoveResult.error?.message);
  assert.equal(await exists("ops/concurrent-tree-moved/child.txt"), true);

  const staleDelete = await core.execute("workspace.delete", {
    path: "ops/moved.txt",
    expectedSha256: "0".repeat(64)
  }, context);
  assert.equal(staleDelete.ok, false);
  assert.equal(staleDelete.error.code, "FILE_CHANGED");
  assert.equal(await exists("ops/moved.txt"), true);

  const deleted = await core.execute("workspace.delete", {
    path: "ops/moved.txt",
    expectedSha256: sourceHash
  }, context);
  assert.equal(deleted.ok, true, deleted.error?.message);
  assert.equal(await exists("ops/moved.txt"), false);

  await mkdir(path.join(workspaceRoot, "ops", "non-empty"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "ops", "non-empty", "a.txt"), "a\n", "utf8");
  const nonRecursive = await core.execute("workspace.delete", { path: "ops/non-empty", recursive: false }, context);
  assert.equal(nonRecursive.ok, false);
  assert.equal(nonRecursive.error.code, "DIRECTORY_NOT_EMPTY");
  const recursive = await core.execute("workspace.delete", { path: "ops/non-empty", recursive: true }, context);
  assert.equal(recursive.ok, true, recursive.error?.message);

  await mkdir(path.join(workspaceRoot, "ops", "sensitive-tree"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "ops", "sensitive-tree", ".env"), "SECRET=nope\n", "utf8");
  const sensitiveDelete = await core.execute("workspace.delete", { path: "ops/sensitive-tree", recursive: true }, context);
  assert.equal(sensitiveDelete.ok, false);
  assert.equal(sensitiveDelete.error.code, "SENSITIVE_PATH");
  const rootDelete = await core.execute("workspace.delete", { path: ".", recursive: true }, context);
  assert.equal(rootDelete.ok, false);

  await writeFile(path.join(workspaceRoot, "ops", "delete-rollback.txt"), "keep\n", "utf8");
  const originalDeleteRename = core.fileOperations.renamePath.bind(core.fileOperations);
  core.fileOperations.renamePath = async () => { throw new Error("injected delete rename failure"); };
  const failedDelete = await core.execute("workspace.delete", {
    path: "ops/delete-rollback.txt",
    expectedSha256: sha256("keep\n")
  }, context);
  core.fileOperations.renamePath = originalDeleteRename;
  assert.equal(failedDelete.ok, false);
  assert.equal(await readFile(path.join(workspaceRoot, "ops", "delete-rollback.txt"), "utf8"), "keep\n");

  await writeFile(path.join(workspaceRoot, "image.png"), png);
  const inspected = await core.execute("artifact.inspect", { path: "image.png" }, context);
  assert.equal(inspected.ok, true, inspected.error?.message);
  assert.equal(inspected.data.structured.mimeType, "image/png");
  assert.deepEqual(inspected.data.structured.image, { width: 1, height: 1 });
  assert.equal(inspected.data.structured.sha256, sha256(png));

  await assert.rejects(resolvePublicArtifactUrl("https://127.0.0.1/private.png"), (error) => {
    assert.equal(error.code, "ARTIFACT_SOURCE_NOT_ALLOWED");
    return true;
  });
  await assert.rejects(resolvePublicArtifactUrl("https://[::1]/private.png"), (error) => {
    assert.equal(error.code, "ARTIFACT_SOURCE_NOT_ALLOWED");
    return true;
  });
  core.artifacts.downloadSource = async () => ({ buffer: png, responseMimeType: "image/png" });
  const imported = await core.execute("artifact.import", {
    source: { url: "https://files.example.test/generated.png", id: "opaque-file-1", mimeType: "image/png", fileName: "generated.png" },
    destination: "artifacts/generated.png",
    expectedSha256: null
  }, context);
  assert.equal(imported.ok, true, imported.error?.message);
  assert.equal(imported.data.structured.action, "created");
  assert.equal(imported.data.structured.sourceScheme, "opaque");
  assert.equal(JSON.stringify(imported).includes("opaque-file-1"), false);
  assert.equal(await readFile(path.join(workspaceRoot, "artifacts", "generated.png")).then(sha256), sha256(png));

  const mismatch = await core.execute("artifact.import", {
    source: { url: "https://files.example.test/generated.png", id: "opaque-file-2", mimeType: "image/png" },
    destination: "artifacts/not-a-pdf.pdf",
    expectedSha256: null
  }, context);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "ARTIFACT_INVALID");
  assert.equal(await exists("artifacts/not-a-pdf.pdf"), false);

  core.artifacts.downloadSource = async () => { throw new Error("injected download failure"); };
  const failedDownload = await core.execute("artifact.import", {
    source: { url: "https://files.example.test/failure.png", id: "opaque-file-secret", mimeType: "image/png" },
    destination: "artifacts/download-failure.png",
    expectedSha256: null
  }, context);
  assert.equal(failedDownload.ok, false);
  assert.equal(failedDownload.error.code, "ARTIFACT_DOWNLOAD_FAILED");
  assert.deepEqual(failedDownload.error.details.sourceShape, {
    url: { present: true, type: "string" },
    id: { present: true, type: "string" },
    mimeType: { present: true, type: "string" },
    fileName: { present: false, type: "undefined" }
  });
  assert.equal(JSON.stringify(failedDownload).includes("files.example.test"), false);
  assert.equal(JSON.stringify(failedDownload).includes("opaque-file-secret"), false);

  const exportResult = await core.execute("artifact.export", { path: "artifacts/generated.png" }, context);
  assert.equal(exportResult.ok, true, exportResult.error?.message);
  assert.match(exportResult.data.structured.resourceUri, /^luna-artifact:\/\/export\/[A-Za-z0-9_-]+$/);
  const token = new URL(exportResult.data.structured.resourceUri).pathname.slice(1);
  const resource = await core.readArtifactResource(token, context);
  assert.equal(resource.ok, true, resource.error?.message);
  assert.equal(sha256(Buffer.from(resource.data.blob, "base64")), sha256(png));

  await writeFile(path.join(workspaceRoot, "artifacts", "generated.png"), Buffer.concat([png, Buffer.from([0])]));
  const staleResource = await core.readArtifactResource(token, context);
  assert.equal(staleResource.ok, false);
  assert.equal(staleResource.error.code, "FILE_CHANGED");

  const protectedActions = core.policy.protectedActions;
  for (const tool of ["workspace.mkdir", "workspace.move", "workspace.delete", "artifact.import", "artifact.export"]) {
    assert.equal(protectedActions.has(tool), true, `${tool} must be approval protected`);
  }
  assert.equal(protectedActions.has("artifact.inspect"), false);

  const audit = core.audit.list(200);
  assert(audit.some((event) => event.tool === "workspace.move" && event.status === "success"));
  assert(audit.some((event) => event.tool === "workspace.delete" && event.status === "error"));
  assert(audit.some((event) => event.tool === "artifact.import" && event.status === "success"));
  assert(audit.some((event) => event.tool === "export_artifact.resource" && event.status === "success"));
  assert.equal(JSON.stringify(audit).includes("files.example.test"), false, "audit must not retain signed download URLs");

  console.log("PASS: create/move/delete enforce revisions, sensitive boundaries, recursion, and root protection");
  console.log("PASS: injected move/delete failures restore the original workspace state");
  console.log("PASS: recursive file operations wait for in-flight descendant mutations");
  console.log("PASS: artifact inspection detects PNG metadata and stable SHA-256 revisions");
  console.log("PASS: artifact import validates signatures and atomically saves authorized bytes");
  console.log("PASS: Host file import preflight validates the destination before atomic commit");
  console.log("PASS: pinned DNS lookup supports Node all-address mode without leaking source credentials");
  console.log("PASS: artifact export resource links are short-lived and revision-bound");
  console.log("PASS: private-network artifact sources are blocked before download");
} finally {
  await core.audit.flush();
  await rm(temporaryRoot, { recursive: true, force: true });
}
