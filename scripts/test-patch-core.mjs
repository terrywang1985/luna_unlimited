import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { createLunaCore } from "../src/core/runtime.mjs";
import { sha256 } from "../src/core/hash.mjs";

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "luna-patch-core-"));
const workspaceRoot = path.join(temporaryRoot, "workspace");
const logsDir = path.join(temporaryRoot, "logs");
const checkpointRoot = path.join(temporaryRoot, "checkpoints");
const context = {
  caller: { clientId: "patch-test", clientName: "direct-core", sessionId: "patch-session", protocol: "direct" },
  workSessionId: "patch-work"
};

function expected(pathname, content) {
  return { path: pathname, sha256: content === null ? null : sha256(content) };
}

async function content(pathname) {
  return readFile(path.join(workspaceRoot, pathname), "utf8");
}

await mkdir(workspaceRoot, { recursive: true });
const core = await createLunaCore({
  workspaceRoot,
  logsDir,
  checkpointRoot,
  maxFileBytes: 1024 * 1024,
  maxBatchBytes: 8 * 1024 * 1024,
  maxCommandOutputBytes: 256 * 1024
});

try {
  const alpha = "one\ntwo\nthree\n";
  const beta = "remove-me\n";
  await writeFile(path.join(workspaceRoot, "alpha.txt"), alpha, "utf8");
  await writeFile(path.join(workspaceRoot, "beta.txt"), beta, "utf8");

  const multiFilePatch = `--- a/alpha.txt
+++ b/alpha.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
--- a/beta.txt
+++ /dev/null
@@ -1 +0,0 @@
-remove-me
--- /dev/null
+++ b/gamma.txt
@@ -0,0 +1,2 @@
+created
+file
`;
  const expectedFiles = [expected("alpha.txt", alpha), expected("beta.txt", beta), expected("gamma.txt", null)];

  const dryRun = await core.execute("code.apply_patch", { patch: multiFilePatch, expectedFiles, dryRun: true }, context);
  assert.equal(dryRun.ok, true, dryRun.error?.message);
  assert.deepEqual(
    { dryRun: dryRun.data.structured.dryRun, committed: dryRun.data.structured.committed, files: dryRun.data.structured.files.length },
    { dryRun: true, committed: false, files: 3 }
  );
  assert.equal(await content("alpha.txt"), alpha);
  assert.equal(await content("beta.txt"), beta);
  await assert.rejects(content("gamma.txt"), { code: "ENOENT" });

  const applied = await core.execute("code.apply_patch", { patch: multiFilePatch, expectedFiles }, context);
  assert.equal(applied.ok, true, applied.error?.message);
  assert.equal(applied.data.structured.committed, true);
  assert.deepEqual(applied.data.structured.totals, { files: 3, bytes: 27, addedLines: 3, removedLines: 2 });
  assert.equal(await content("alpha.txt"), "one\nTWO\nthree\n");
  await assert.rejects(content("beta.txt"), { code: "ENOENT" });
  assert.equal(await content("gamma.txt"), "created\nfile\n");

  const stableAlpha = await content("alpha.txt");
  const stableGamma = await content("gamma.txt");
  const stalePatch = `--- a/alpha.txt
+++ b/alpha.txt
@@ -1 +1 @@
-one
+ONE
`;
  const stale = await core.execute("code.apply_patch", {
    patch: stalePatch,
    expectedFiles: [{ path: "alpha.txt", sha256: "0".repeat(64) }]
  }, context);
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "FILE_CHANGED");
  assert.equal(stale.error.details.phase, "validation");
  assert.equal(await content("alpha.txt"), stableAlpha);

  const mismatchPatch = `--- a/alpha.txt
+++ b/alpha.txt
@@ -1 +1 @@
-not-one
+ONE
`;
  const mismatch = await core.execute("code.apply_patch", {
    patch: mismatchPatch,
    expectedFiles: [expected("alpha.txt", stableAlpha)]
  }, context);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "PATCH_CONTEXT_MISMATCH");
  assert.equal(await content("alpha.txt"), stableAlpha);

  const traversal = await core.execute("code.apply_patch", {
    patch: `--- /dev/null\n+++ b/../outside.txt\n@@ -0,0 +1 @@\n+blocked\n`,
    expectedFiles: [{ path: "../outside.txt", sha256: null }]
  }, context);
  assert.equal(traversal.ok, false);
  assert.equal(traversal.error.code, "PATH_OUTSIDE_WORKSPACE");

  const sensitive = await core.execute("code.apply_patch", {
    patch: `--- /dev/null\n+++ b/.env\n@@ -0,0 +1 @@\n+SECRET=blocked\n`,
    expectedFiles: [{ path: ".env", sha256: null }]
  }, context);
  assert.equal(sensitive.ok, false);
  assert.equal(sensitive.error.code, "SENSITIVE_PATH");

  const rollbackPatch = `--- a/alpha.txt
+++ b/alpha.txt
@@ -2 +2 @@
-TWO
+two-again
--- a/gamma.txt
+++ b/gamma.txt
@@ -1 +1 @@
-created
+CREATED
`;
  const originalWriter = core.patch.writePreparedFile.bind(core.patch);
  let writes = 0;
  core.patch.writePreparedFile = async (file) => {
    writes += 1;
    if (writes === 2) throw new Error("injected patch commit failure");
    return originalWriter(file);
  };
  const rolledBack = await core.execute("code.apply_patch", {
    patch: rollbackPatch,
    expectedFiles: [expected("alpha.txt", stableAlpha), expected("gamma.txt", stableGamma)]
  }, context);
  core.patch.writePreparedFile = originalWriter;
  assert.equal(rolledBack.ok, false);
  assert.equal(rolledBack.error.details.phase, "rollback");
  assert.equal(rolledBack.error.details.rolledBack, true);
  assert.equal(await content("alpha.txt"), stableAlpha);
  assert.equal(await content("gamma.txt"), stableGamma);

  await writeFile(path.join(workspaceRoot, "crlf.txt"), "a\r\nb\r\n", "utf8");
  const crlfPatch = `--- a/crlf.txt\n+++ b/crlf.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n`;
  const crlfResult = await core.execute("code.apply_patch", {
    patch: crlfPatch,
    expectedFiles: [expected("crlf.txt", "a\r\nb\r\n")]
  }, context);
  assert.equal(crlfResult.ok, true, crlfResult.error?.message);
  assert.equal(await content("crlf.txt"), "a\r\nB\r\n");

  const noNewlinePatch = await core.execute("code.apply_patch", {
    patch: `--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1 +1 @@\n-one\n\\ No newline at end of file\n+ONE\n`,
    expectedFiles: [expected("alpha.txt", stableAlpha)]
  }, context);
  assert.equal(noNewlinePatch.ok, false);
  assert.equal(noNewlinePatch.error.code, "PATCH_UNSUPPORTED");

  assert.equal(core.policy.protectedActions.has("code.apply_patch"), true);
  const patchAudits = core.audit.list(100).filter((event) => event.tool === "code.apply_patch");
  assert(patchAudits.some((event) => event.status === "success" && event.details.phase === "committed"));
  assert(patchAudits.some((event) => event.status === "success" && event.details.phase === "dry_run"));
  assert(patchAudits.some((event) => event.status === "error" && event.details.phase === "validation"));
  assert(patchAudits.some((event) => event.status === "error" && event.details.phase === "rollback" && event.details.rolledBack));

  console.log("PASS: unified diff dry-run validates without modifying files");
  console.log("PASS: create/update/delete patch commits atomically with SHA-256 expectations");
  console.log("PASS: stale revisions, context mismatches, traversal, and sensitive paths fail before commit");
  console.log("PASS: injected commit failure restores every earlier file and records rollback audit state");
  console.log("PASS: CRLF files preserve line endings and unsupported no-newline patches fail closed");
} finally {
  await core.audit.flush();
  await rm(temporaryRoot, { recursive: true, force: true });
}
